/// <reference types="jest" />
/// <reference types="node" />

jest.mock("expo-secure-store");
jest.mock("../src/lib/session");

import * as SecureStore from "expo-secure-store";
import { buildReport, setCurrentScreen, reportError, readQueue, flushCrashQueue, installCrashReporter } from "../src/lib/crashReport";

// An in-memory stand-in for the device keychain, so the queue's slot behaviour is exercised for
// real rather than mocked away -- the whole point of the queue is surviving a process that dies.
function fakeStore() {
  const store = new Map<string, string>();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation((k: string) =>
    Promise.resolve(store.get(k) ?? null)
  );
  // The async write DEFERS its mutation, which is what a real keychain write does: the value is
  // not on disk when the call returns, it lands a tick later. Mutating the Map synchronously here
  // would make an un-awaited async write indistinguishable from a synchronous one -- and the whole
  // point of the sync path is that a fatal error kills the process before that tick ever runs.
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(
    (k: string, v: string) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          store.set(k, v);
          resolve();
        }, 0);
      })
  );
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation((k: string) => {
    store.delete(k);
    return Promise.resolve();
  });
  // The SYNCHRONOUS pair, which is what the global handler actually uses. A fatal error tears the
  // process down as soon as the previous handler runs, so an awaited write never lands -- these
  // being real (not promise-returning) is the whole mechanism under test.
  (SecureStore.getItem as jest.Mock).mockImplementation((k: string) => store.get(k) ?? null);
  (SecureStore.setItem as jest.Mock).mockImplementation((k: string, v: string) => {
    store.set(k, v);
  });
  return store;
}

describe("crash reporting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeStore();
    setCurrentScreen(null);
  });

  it("captures the message, the stack and the screen that was open", () => {
    setCurrentScreen("/recents");
    const report = buildReport(new TypeError("undefined is not an object"), true);
    expect(report.name).toBe("TypeError");
    expect(report.message).toBe("undefined is not an object");
    expect(report.screen).toBe("/recents");
    expect(report.fatal).toBe(true);
    expect(report.otaBuild).toMatch(/^\d+$/);
  });

  it("handles a thrown non-Error, which is what native callbacks tend to produce", () => {
    const report = buildReport("connection lost", false);
    expect(report.message).toBe("connection lost");
    expect(report.name).toBeNull();
    expect(report.stack).toBeNull();
  });

  it("truncates a runaway stack so it still fits a SecureStore slot", () => {
    const err = new Error("boom");
    err.stack = "x".repeat(100_000);
    expect(buildReport(err, true).stack!.length).toBeLessThan(2000);
  });

  // The reason the queue exists: a fatal error kills the app before the request completes, so the
  // report has to be on disk before the send is even attempted.
  it("keeps the report on the device when the send fails", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("offline"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await reportError(new Error("crashed"), true);

    const { entries } = await readQueue();
    expect(entries).toHaveLength(1);
    expect(entries[0].report.message).toBe("crashed");
  });

  it("clears the queue once the report is delivered", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stored: 1 }),
    } as Response) as unknown as typeof fetch;

    await reportError(new Error("crashed"), true);
    expect((await readQueue()).entries).toHaveLength(0);
  });

  // The report has to be on the device BEFORE the handler that kills the process runs. It used to
  // be written by an un-awaited async call, so on a genuinely fatal error the write raced teardown
  // and lost -- which is why `client_errors` sat empty from the day crash reporting shipped.
  it("writes the report synchronously, before the previous handler can tear the app down", async () => {
    const store = fakeStore();
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    let sawReportAtTeardown = false;
    const g = global as unknown as { ErrorUtils: Record<string, unknown> };
    let installed: ((e: unknown, fatal?: boolean) => void) | undefined;
    g.ErrorUtils = {
      // Stands in for React Native's own handler: by the time this runs the process is going away,
      // so whatever is not already on disk is gone.
      getGlobalHandler: () => () => {
        sawReportAtTeardown = [...store.values()].some((v) => v.includes("fatal boom"));
      },
      setGlobalHandler: (fn: (e: unknown, fatal?: boolean) => void) => {
        installed = fn;
      },
    };
    installCrashReporter();
    installed?.(new Error("fatal boom"), true);
    expect(sawReportAtTeardown).toBe(true);
    // The handler fires a flush it deliberately does not await. Let it settle here, or it is still
    // holding the module's in-flight latch when the next test clears the mocks underneath it.
    await flushCrashQueue();
  });

  // A second crash during the in-flight POST overwrites slot 0 (enqueueSync wraps). Deleting "the
  // slots we read" by INDEX then throws that newer report away unsent -- so the delete has to prove
  // the contents are still the ones it sent.
  // A second crash during the in-flight POST overwrites slot 0 (enqueueSync wraps). Deleting "the
  // slots we read" by INDEX then throws that newer report away unsent -- so the delete has to prove
  // the contents are still the ones it sent.
  it("does not delete a report that replaced one mid-send", async () => {
    const store = fakeStore();
    // Queue the first report WITHOUT a successful send -- reportError flushes, so a hanging fetch
    // here would trap the setup rather than the flush under test.
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await reportError(new Error("first"), false);

    let release: (() => void) | undefined;
    const sending = new Promise<void>((seen) => {
      global.fetch = jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ ok: true, status: 200, json: () => Promise.resolve({ stored: 1 }) } as Response);
            seen(); // the POST is now open
          })
      ) as unknown as typeof fetch;
    });

    const flush = flushCrashQueue();
    await sending;
    // The replacement lands while the POST is still open.
    store.set("crash_report_0", JSON.stringify(buildReport(new Error("second"), true)));
    release?.();
    await flush;

    const { entries } = await readQueue();
    expect(entries).toHaveLength(1);
    expect(entries[0].report.message).toBe("second");
  });

  // enqueueSync counts any non-null slot as taken, so a slot that will not parse is occupied
  // forever -- four of them and every report lands in slot 0 and is overwritten by the next.
  it("reclaims a slot whose contents will not parse", async () => {
    const store = fakeStore();
    store.set("crash_report_0", "{not json");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stored: 0 }),
    } as Response) as unknown as typeof fetch;

    await flushCrashQueue();
    expect(store.has("crash_report_0")).toBe(false);
  });

  it("does not swallow the crash: the previous handler still runs", () => {
    const previous = jest.fn();
    const g = global as unknown as { ErrorUtils: Record<string, unknown> };
    let installed: ((e: unknown, fatal?: boolean) => void) | undefined;
    g.ErrorUtils = {
      getGlobalHandler: () => previous,
      setGlobalHandler: (fn: (e: unknown, fatal?: boolean) => void) => {
        installed = fn;
      },
    };
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    installCrashReporter();
    const err = new Error("boom");
    installed!(err, true);

    expect(previous).toHaveBeenCalledWith(err, true);
  });
});

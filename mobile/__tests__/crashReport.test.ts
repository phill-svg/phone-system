/// <reference types="jest" />
/// <reference types="node" />

jest.mock("expo-secure-store");
jest.mock("../src/lib/session");

import * as SecureStore from "expo-secure-store";
import { buildReport, setCurrentScreen, reportError, readQueue, installCrashReporter } from "../src/lib/crashReport";

// An in-memory stand-in for the device keychain, so the queue's slot behaviour is exercised for
// real rather than mocked away -- the whole point of the queue is surviving a process that dies.
function fakeStore() {
  const store = new Map<string, string>();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation((k: string) =>
    Promise.resolve(store.get(k) ?? null)
  );
  (SecureStore.setItemAsync as jest.Mock).mockImplementation((k: string, v: string) => {
    store.set(k, v);
    return Promise.resolve();
  });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation((k: string) => {
    store.delete(k);
    return Promise.resolve();
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

    const queued = await readQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].message).toBe("crashed");
  });

  it("clears the queue once the report is delivered", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stored: 1 }),
    } as Response) as unknown as typeof fetch;

    await reportError(new Error("crashed"), true);
    expect(await readQueue()).toHaveLength(0);
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

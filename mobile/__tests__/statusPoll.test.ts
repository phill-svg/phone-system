import { startStatusPoll, type RegStatus } from "../src/lib/statusPoll";

// The connection badge's /api/me poll. It used to share ONE `alive` ref across effect runs, reset to
// true by every run, so a ping still in flight when signing out came back to a live flag: it re-armed
// the loop and kept GETting /api/me while signed out, and a zombie ping's 401 landing just after the
// next sign-in's setToken ran apiFetch's clearToken -- deleting the fresh token and bouncing the user
// back to login. Each poll now owns its liveness, and stopping it aborts what it has in flight.
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("startStatusPoll", () => {
  let statuses: RegStatus[];
  const setup = (request: (signal: AbortSignal) => Promise<unknown>) => {
    statuses = [];
    return startStatusPoll({ request, setStatus: (s) => statuses.push(s), getStatus: () => statuses[statuses.length - 1] ?? "connecting" });
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("reports registered and arms the next poll on success", async () => {
    const poll = setup(async () => {});
    await drain();
    expect(statuses).toEqual(["connecting", "registered"]);
    // The next poll, and nothing else (the ping's own timeout was cleared).
    expect(jest.getTimerCount()).toBe(1);
    poll.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborts the request in flight when stopped, so its 401 can never clear a later sign-in's token", async () => {
    let seen: AbortSignal | undefined;
    const poll = setup((signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    await drain();
    expect(seen?.aborted).toBe(false);
    poll.stop();
    expect(seen?.aborted).toBe(true);
  });

  it("a ping that settles after stop sets no status and re-arms nothing", async () => {
    const pending = deferred();
    const poll = setup(() => pending.promise);
    await drain();
    poll.stop();
    pending.reject(new Error("unauthorized"));
    await drain();
    expect(statuses).toEqual(["connecting"]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("stopping one poll does not revive or silence the next", async () => {
    const first = deferred();
    const old = setup(() => first.promise);
    await drain();
    old.stop();
    const requests: number[] = [];
    const next = startStatusPoll({
      request: async () => {
        requests.push(1);
      },
      setStatus: () => {},
      getStatus: () => "connecting",
    });
    first.resolve();
    await drain();
    // The old ping resolving must not have armed a second loop beside the new one.
    expect(jest.getTimerCount()).toBe(1);
    expect(requests).toHaveLength(1);
    next.stop();
  });
});

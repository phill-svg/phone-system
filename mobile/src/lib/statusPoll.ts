export type RegStatus = "connecting" | "registered" | "reconnecting" | "failed" | "offline";

// Poll cadence when healthy, and how long a single ping is allowed to hang before it's treated as
// a failure (plain fetch() has no default timeout, so a degraded connection could otherwise hang
// far longer than the poll interval itself -- the "taking forever" symptom).
const BASE_INTERVAL_MS = 25000;
const MAX_INTERVAL_MS = 120000;
const PING_TIMEOUT_MS = 8000;
// A single dropped ping is normal on mobile data and shouldn't flip the badge; only a run of
// consecutive failures means something is actually wrong, and it re-checks less often the longer
// it stays down instead of hammering the backend every 25s indefinitely.
const FAILS_BEFORE_RECONNECTING = 2;
const FAILS_BEFORE_FAILED = 5;

// One poll's whole life. Liveness is LOCAL to it, never a ref shared across restarts: a shared flag
// reset to true by the next start let a ping still in flight from the previous one re-arm its loop
// after sign-out -- polling /api/me while signed out, and a zombie ping's 401 landing after the next
// sign-in ran apiFetch's clearToken over the fresh token. `stop` also aborts the request itself,
// because a liveness check cannot stop apiFetch clearing the token when that 401 arrives.
export function startStatusPoll(opts: {
  request: (signal: AbortSignal) => Promise<unknown>;
  setStatus: (s: RegStatus) => void;
  getStatus: () => RegStatus;
}): { stop: () => void; refresh: () => Promise<void> } {
  let active = true;
  let failCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const inFlight = new Set<AbortController>();

  async function ping(): Promise<void> {
    if (!active) return;
    const controller = new AbortController();
    inFlight.add(controller);
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      await opts.request(controller.signal);
      if (!active) return;
      failCount = 0;
      opts.setStatus("registered");
    } catch {
      if (!active) return;
      failCount += 1;
      if (failCount >= FAILS_BEFORE_FAILED) opts.setStatus("failed");
      else if (failCount >= FAILS_BEFORE_RECONNECTING || opts.getStatus() !== "registered") {
        opts.setStatus("reconnecting");
      }
      // else: first blip while previously registered -- stay "registered", don't flap.
    } finally {
      clearTimeout(timeout);
      inFlight.delete(controller);
    }
  }

  async function run(): Promise<void> {
    await ping();
    if (!active) return;
    // Back off the more it fails in a row (capped), and snap back to the normal cadence the
    // moment it succeeds again -- no fixed-interval hammering while the backend is unreachable.
    const delay = failCount === 0 ? BASE_INTERVAL_MS : Math.min(BASE_INTERVAL_MS * 2 ** failCount, MAX_INTERVAL_MS);
    timer = setTimeout(run, delay);
  }

  opts.setStatus("connecting");
  void run();

  return {
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      inFlight.forEach((c) => c.abort());
    },
    refresh: ping,
  };
}

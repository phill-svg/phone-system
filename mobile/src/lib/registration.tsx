import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { apiFetch } from "./api";

// VoIP/service registration state shown subtly in the UI.
// Today it reflects whether the app can reach the TCB backend (a real signal, not
// faked): connecting on launch, registered when reachable, reconnecting on a blip,
// failed if it stays down. When the native Twilio Voice layer lands it will drive
// these same states from true SIP registration via `setStatus`.
export type RegStatus = "connecting" | "registered" | "reconnecting" | "failed" | "offline";

type RegContext = { status: RegStatus; setStatus: (s: RegStatus) => void; refresh: () => void };

const Ctx = createContext<RegContext>({ status: "offline", setStatus: () => {}, refresh: () => {} });

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

export function RegistrationProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [status, setStatus] = useState<RegStatus>("connecting");
  const alive = useRef(true);
  const statusRef = useRef<RegStatus>(status);
  statusRef.current = status;
  const failCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ping = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      await apiFetch("/api/me", { signal: controller.signal });
      failCount.current = 0;
      if (alive.current) setStatus("registered");
    } catch {
      failCount.current += 1;
      if (alive.current) {
        if (failCount.current >= FAILS_BEFORE_FAILED) setStatus("failed");
        else if (failCount.current >= FAILS_BEFORE_RECONNECTING || statusRef.current !== "registered") {
          setStatus("reconnecting");
        }
        // else: first blip while previously registered -- stay "registered", don't flap.
      }
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setStatus("offline");
      return () => {
        alive.current = false;
        if (timer.current) clearTimeout(timer.current);
      };
    }
    setStatus("connecting");
    failCount.current = 0;

    const run = async () => {
      await ping();
      if (!alive.current) return;
      // Back off the more it fails in a row (capped), and snap back to the normal cadence the
      // moment it succeeds again -- no fixed-interval hammering while the backend is unreachable.
      const delay =
        failCount.current === 0 ? BASE_INTERVAL_MS : Math.min(BASE_INTERVAL_MS * 2 ** failCount.current, MAX_INTERVAL_MS);
      timer.current = setTimeout(run, delay);
    };
    run();

    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ping, enabled]);

  return <Ctx.Provider value={{ status, setStatus, refresh: ping }}>{children}</Ctx.Provider>;
}

export function useRegistration(): RegContext {
  return useContext(Ctx);
}

export const REG_META: Record<RegStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  connecting: { label: "Connecting…", tone: "warning" },
  registered: { label: "Connected", tone: "success" },
  reconnecting: { label: "Reconnecting…", tone: "warning" },
  failed: { label: "Not connected", tone: "danger" },
  offline: { label: "Offline", tone: "neutral" },
};

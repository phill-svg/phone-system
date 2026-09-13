import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { apiFetch } from "./api";
import { startStatusPoll, type RegStatus } from "./statusPoll";

// VoIP/service registration state shown subtly in the UI.
// Today it reflects whether the app can reach the TCB backend (a real signal, not
// faked): connecting on launch, registered when reachable, reconnecting on a blip,
// failed if it stays down. When the native Twilio Voice layer lands it will drive
// these same states from true SIP registration via `setStatus`.
export type { RegStatus };

type RegContext = { status: RegStatus; setStatus: (s: RegStatus) => void; refresh: () => void };

const Ctx = createContext<RegContext>({ status: "offline", setStatus: () => {}, refresh: () => {} });

export function RegistrationProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [status, setStatus] = useState<RegStatus>("connecting");
  const statusRef = useRef<RegStatus>(status);
  statusRef.current = status;
  const poll = useRef<ReturnType<typeof startStatusPoll> | null>(null);

  // A fresh poll per effect run, stopped (in-flight ping aborted) in its cleanup -- see statusPoll.ts
  // for why liveness must not be shared across runs.
  useEffect(() => {
    if (!enabled) {
      setStatus("offline");
      return;
    }
    const current = startStatusPoll({
      request: (signal) => apiFetch("/api/me", { signal }),
      setStatus,
      getStatus: () => statusRef.current,
    });
    poll.current = current;
    return () => {
      current.stop();
      if (poll.current === current) poll.current = null;
    };
  }, [enabled]);

  const refresh = useCallback(() => {
    void poll.current?.refresh();
  }, []);

  return <Ctx.Provider value={{ status, setStatus, refresh }}>{children}</Ctx.Provider>;
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

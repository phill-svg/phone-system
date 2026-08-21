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

export function RegistrationProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [status, setStatus] = useState<RegStatus>("connecting");
  const alive = useRef(true);
  const statusRef = useRef<RegStatus>(status);
  statusRef.current = status;

  const ping = useCallback(async () => {
    try {
      await apiFetch("/api/me");
      if (alive.current) setStatus("registered");
    } catch {
      if (alive.current) setStatus(statusRef.current === "registered" ? "reconnecting" : "failed");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setStatus("offline");
      return () => { alive.current = false; };
    }
    setStatus("connecting");
    ping();
    const id = setInterval(ping, 25000);
    return () => {
      alive.current = false;
      clearInterval(id);
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

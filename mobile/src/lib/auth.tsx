import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getToken, setToken, clearToken } from "./session";
import { login as apiLogin, logout as apiLogout, setUnauthorizedHandler, type StaffUser } from "./api";

type Status = "loading" | "authed" | "anon";
type AuthValue = {
  status: Status;
  user: StaffUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<StaffUser | null>(null);

  useEffect(() => {
    // A 401 anywhere drops us to anon.
    setUnauthorizedHandler(() => { setUser(null); setStatus("anon"); });
    (async () => {
      const token = await getToken();
      setStatus(token ? "authed" : "anon");
    })();
    return () => setUnauthorizedHandler(null);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    status,
    user,
    async signIn(email, password) {
      const { token, user: u } = await apiLogin(email, password);
      await setToken(token);
      setUser(u);
      setStatus("authed");
    },
    async signOut() {
      await apiLogout();
      await clearToken();
      setUser(null);
      setStatus("anon");
    },
  }), [status, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

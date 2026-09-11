import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getToken, setToken } from "./session";
import { login as apiLogin, getMe, setUnauthorizedHandler, type StaffUser } from "./api";
import { performSignOut } from "./signOut";

type Status = "loading" | "authed" | "anon";
type AuthValue = {
  status: Status;
  user: StaffUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  // Resolves false when this handset could NOT be unregistered from Twilio, i.e. it may keep
  // ringing for customer calls. The caller is expected to tell the user; nothing else can.
  signOut: () => Promise<boolean>;
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
      if (!token) { setStatus("anon"); return; }
      setStatus("authed");
      // Sign-in is the only other place `user` is set, so a relaunch restored the token but left
      // us with no idea who it belonged to -- Settings showed an empty Account row and everyone
      // looked like Staff. Ask the server. A 401 here drops us to anon via the handler above.
      try {
        setUser(await getMe());
      } catch {
        // Offline or a hiccup: stay signed in on the token we have and try again on next launch.
      }
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
      // The whole sequence lives in `performSignOut` so it can be tested -- what is left here is
      // React state, which is all this component should own. See that module for why the order is
      // load-bearing and why `./voice` is imported lazily.
      const { ringingStopped } = await performSignOut();
      setUser(null);
      setStatus("anon");
      return ringingStopped;
    },
  }), [status, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

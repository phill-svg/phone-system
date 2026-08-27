import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { getUserSettings, updateUserSettings, type UserSettings } from "./api";
import { useAuth } from "./auth";

const DEFAULTS: UserSettings = {
  notif_incoming: true,
  notif_missed: true,
  notif_voicemail: true,
  notif_sms: true,
  ring_my_mobile: false,
  mobile_number: "",
};

const CACHE_KEY = "user_settings_cache";

type Ctx = { settings: UserSettings; update: (p: Partial<UserSettings>) => void; loaded: boolean };
const UserSettingsContext = createContext<Ctx>({ settings: DEFAULTS, update: () => {}, loaded: false });

export function UserSettingsProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Paint from cache immediately, then refresh from the server once signed in.
  useEffect(() => {
    SecureStore.getItemAsync(CACHE_KEY)
      .then((raw) => {
        if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<UserSettings>) });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (status !== "authed") return;
    getUserSettings()
      .then((s) => {
        setSettings(s);
        SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(s)).catch(() => {});
      })
      .catch(() => {}); // keep cached values on network failure
  }, [status]);

  // Optimistic update: reflect locally + cache now, write through to the server, reconcile on reply.
  const update = (partial: Partial<UserSettings>) => {
    const next = { ...settingsRef.current, ...partial };
    setSettings(next);
    SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(next)).catch(() => {});
    updateUserSettings(partial)
      .then((server) => {
        setSettings(server);
        SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(server)).catch(() => {});
      })
      .catch(() => {}); // leave the optimistic value; next launch re-syncs from server
  };

  return (
    <UserSettingsContext.Provider value={{ settings, update, loaded }}>
      {children}
    </UserSettingsContext.Provider>
  );
}

export function useUserSettings(): Ctx {
  return useContext(UserSettingsContext);
}

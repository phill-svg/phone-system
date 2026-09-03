import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";

// A boolean preference that persists across app launches (SecureStore-backed). Loads
// asynchronously on mount, falling back to `initial` until the stored value arrives.
export function usePersistedBool(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    SecureStore.getItemAsync(key)
      .then((v) => {
        if (v === "1" || v === "0") setValue(v === "1");
      })
      .catch(() => {});
  }, [key]);
  const set = (v: boolean) => {
    setValue(v);
    SecureStore.setItemAsync(key, v ? "1" : "0").catch(() => {});
  };
  return [value, set];
}

// A string preference that persists across app launches. `valid` guards against a stored value
// that no longer makes sense -- e.g. a remembered caller-ID number that has since been deleted or
// had its voice capability turned off -- in which case the fallback is used instead of silently
// sending from a number the business no longer owns.
export function usePersistedString(
  key: string,
  valid: (v: string) => boolean
): [string | null, (v: string) => void] {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    SecureStore.getItemAsync(key)
      .then((v) => {
        if (v) setValue(v);
      })
      .catch(() => {});
  }, [key]);
  const set = (v: string) => {
    setValue(v);
    SecureStore.setItemAsync(key, v).catch(() => {});
  };
  return [value !== null && valid(value) ? value : null, set];
}

// Non-hook variants for use outside React components (e.g. voice.ts, which is native glue
// code, not a component). Same SecureStore-backed persistence as usePersistedBool above.
export async function getPref(key: string, fallback: string): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setPref(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    /* ignore */
  }
}

export async function getPrefBool(key: string, fallback: boolean): Promise<boolean> {
  const v = await getPref(key, fallback ? "1" : "0");
  return v === "1";
}

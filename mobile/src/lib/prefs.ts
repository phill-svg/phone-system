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

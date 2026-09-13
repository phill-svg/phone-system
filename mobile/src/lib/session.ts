import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

// v2 is readable after the first unlock since boot. A VoIP push launches the app on a LOCKED
// iPhone, and the original key used SecureStore's default (WHEN_UNLOCKED), so the restore threw
// and the app sat on its spinner with no call UI. Accessibility is fixed when an item is written
// and SecureStore's update keeps it, hence a new key rather than a rewrite.
const TOKEN_KEY = "tcb_session_token_v2";
const LEGACY_TOKEN_KEY = "tcb_session_token";
const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

// Shared while in flight: api.ts and the auth restore both read at launch, and two moves racing can
// delete the legacy key between the other's reads -- null, a 401, and a sign-out. Cleared on
// settle, so a failed read is never cached.
let inFlight: Promise<string | null> | null = null;
export function getToken(): Promise<string | null> {
  if (!inFlight) inFlight = readToken().finally(() => { inFlight = null; });
  return inFlight;
}

async function readToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) return token;
  const legacy = await SecureStore.getItemAsync(LEGACY_TOKEN_KEY);
  if (!legacy) return null;
  // Written before deleting, so a crash in between cannot sign anyone out.
  await SecureStore.setItemAsync(TOKEN_KEY, legacy, OPTIONS);
  await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
  return legacy;
}

// A refused read is not "signed out": wait until the app is active (unlocked) and read again. If it
// is ALREADY active, no change event will come -- retry at once, and a second refusal while active
// is not the lock (an Android keystore that cannot decrypt), so it counts as signed out rather than
// a spinner forever.
//
// Only a read that STARTED while active counts: one that started locked and landed after an unlock
// was still the lock. And the retry waits a moment, because iOS can report active slightly before
// protected data is readable -- counting that as a real refusal signed out a valid token.
const RETRY_DELAY_MS = 300;
export async function getTokenWhenReadable(): Promise<string | null> {
  let refusedWhileActive = false;
  for (;;) {
    const activeAtStart = AppState.currentState === "active";
    try {
      return await getToken();
    } catch {
      if (AppState.currentState === "active") {
        if (activeAtStart) {
          if (refusedWhileActive) return null;
          refusedWhileActive = true;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      await new Promise<void>((resolve) => {
        const sub = AppState.addEventListener("change", (s) => {
          if (s === "active") {
            sub.remove();
            resolve();
          }
        });
      });
    }
  }
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token, OPTIONS);
}
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
}

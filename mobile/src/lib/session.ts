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

// A refused read is not "signed out": wait until the app is active (unlocked) and read again.
//
// While active, back off and retry rather than judging any single refusal: iOS can report active a
// moment before protected data is readable, whether the read started locked or right after a wake,
// and each "count only some refusals" rule tried here signed out a valid token in one order or the
// other. Refusal that outlasts the backoff (~3s) is not the lock -- an Android keystore that cannot
// decrypt -- so it counts as signed out rather than a spinner forever.
const ACTIVE_RETRY_DELAYS_MS = [200, 400, 800, 1600];
export async function getTokenWhenReadable(): Promise<string | null> {
  let activeRefusals = 0;
  for (;;) {
    try {
      return await getToken();
    } catch {
      if (AppState.currentState === "active") {
        if (activeRefusals >= ACTIVE_RETRY_DELAYS_MS.length) return null;
        await new Promise((r) => setTimeout(r, ACTIVE_RETRY_DELAYS_MS[activeRefusals++]));
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
      // A fresh unlock gets the full backoff, not what the last one left over.
      activeRefusals = 0;
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

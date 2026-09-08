import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { OTA_BUILD } from "./build";
import { apiFetch } from "./api";

// Crash reporting, because there wasn't any.
//
// When the app started crash-looping there was nothing to read: TestFlight's crash logs need an App
// Store Connect API key that isn't configured, and Play's Developer Reporting API is disabled on
// the project. The only move left was rolling the OTA back and guessing.
//
// The hard part is that a fatal error kills the app before an HTTP request can finish, so sending
// on the spot loses exactly the reports that matter most. Every report is therefore WRITTEN TO THE
// DEVICE FIRST and sent on the next launch. The send is a bonus; the write is the mechanism.

export type CrashReport = {
  platform: string;
  otaBuild: string;
  appVersion: string | null;
  fatal: boolean;
  name: string | null;
  message: string;
  stack: string | null;
  screen: string | null;
  occurredAt: number;
};

// SecureStore values are size-limited (Android warns and can fail past ~2KB), so the queue is a
// handful of fixed slots rather than one growing blob -- each report gets its own key and its own
// budget, and a crash loop overwrites the oldest instead of growing without bound.
const SLOTS = 4;
const slotKey = (i: number) => `crash_report_${i}`;
const MAX_STACK = 1400;
const MAX_MESSAGE = 400;

// Where the user was when it broke. A stack trace off a minified bundle is often unreadable; the
// route usually isn't. Kept in a module variable because the global error handler runs outside
// React and has no way to ask a hook.
let currentScreen: string | null = null;
export function setCurrentScreen(screen: string | null): void {
  currentScreen = screen;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describe(error: unknown): { name: string | null; message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      name: error.name || null,
      message: truncate(error.message || String(error), MAX_MESSAGE),
      stack: error.stack ? truncate(error.stack, MAX_STACK) : null,
    };
  }
  return { name: null, message: truncate(String(error), MAX_MESSAGE), stack: null };
}

export function buildReport(error: unknown, fatal: boolean): CrashReport {
  const { name, message, stack } = describe(error);
  return {
    platform: Platform.OS,
    otaBuild: OTA_BUILD,
    appVersion: Constants.expoConfig?.version ?? null,
    fatal,
    name,
    message,
    stack,
    screen: currentScreen,
    occurredAt: Date.now(),
  };
}

// Writes the report to the first free slot, wrapping onto slot 0 once they are all taken. Never
// throws: this runs while the app is already failing, and a reporting error that masks the original
// one is worse than no report at all.
async function enqueue(report: CrashReport): Promise<void> {
  const json = JSON.stringify(report);
  for (let i = 0; i < SLOTS; i++) {
    try {
      if ((await SecureStore.getItemAsync(slotKey(i))) === null) {
        await SecureStore.setItemAsync(slotKey(i), json);
        return;
      }
    } catch {
      // A slot that can't be read is one we can't safely claim; try the next.
    }
  }
  try {
    await SecureStore.setItemAsync(slotKey(0), json);
  } catch {
    /* Out of options. The app is going down either way. */
  }
}

// Records an error. The queue write is awaited first so the report survives the process dying; the
// send is attempted afterwards and its failure is immaterial -- the next launch will retry.
export async function reportError(error: unknown, fatal: boolean): Promise<void> {
  const report = buildReport(error, fatal);
  await enqueue(report);
  try {
    await apiFetch("/api/client-errors", { method: "POST", body: JSON.stringify([report]) });
    await clearQueue();
  } catch {
    /* Kept on device for the next launch. */
  }
}

async function clearQueue(): Promise<void> {
  for (let i = 0; i < SLOTS; i++) {
    try {
      await SecureStore.deleteItemAsync(slotKey(i));
    } catch {
      /* Nothing useful to do; a stale slot is only ever re-sent, never lost. */
    }
  }
}

export async function readQueue(): Promise<CrashReport[]> {
  const out: CrashReport[] = [];
  for (let i = 0; i < SLOTS; i++) {
    try {
      const raw = await SecureStore.getItemAsync(slotKey(i));
      if (raw) out.push(JSON.parse(raw) as CrashReport);
    } catch {
      /* A corrupt slot is skipped rather than allowed to block the rest of the queue. */
    }
  }
  return out;
}

// Sends whatever last launch could not. Called once the user is signed in, because the endpoint is
// authenticated -- reports simply wait in the queue until then.
export async function flushCrashQueue(): Promise<void> {
  const queued = await readQueue();
  if (queued.length === 0) return;
  try {
    await apiFetch("/api/client-errors", { method: "POST", body: JSON.stringify(queued) });
    await clearQueue();
  } catch {
    /* Still no connection, or still signed out. Try again next launch. */
  }
}

// Catches errors React never sees: async rejections, native callbacks, event handlers. The previous
// handler is CHAINED rather than replaced, so the app still does whatever it did before -- red box
// in development, crash in production. This observes; it does not change behaviour.
export function installCrashReporter(): void {
  const globalWithErrorUtils = global as unknown as { ErrorUtils?: ErrorUtilsShape };
  const errorUtils = globalWithErrorUtils.ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    void reportError(error, isFatal === true);
    previous?.(error, isFatal);
  });
}

type ErrorUtilsShape = {
  setGlobalHandler?: (fn: (error: unknown, isFatal?: boolean) => void) => void;
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
};

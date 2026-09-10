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
//
// SYNCHRONOUS, and that is the whole point. The global handler cannot await anything -- React
// Native calls it and then runs the previous handler, which on a fatal error tears the process
// down -- so an awaited SecureStore write races the teardown and loses exactly the reports that
// matter most. This file's own header promised the report is "WRITTEN TO THE DEVICE FIRST"; with
// the async API it was not, and `client_errors` sat empty from the day crash reporting shipped.
// expo-secure-store 15's setItem/getItem are the sync pair that makes the promise true.
function enqueueSync(report: CrashReport): void {
  const json = JSON.stringify(report);
  for (let i = 0; i < SLOTS; i++) {
    try {
      if (SecureStore.getItem(slotKey(i)) === null) {
        SecureStore.setItem(slotKey(i), json);
        return;
      }
    } catch {
      // A slot that can't be read is one we can't safely claim; try the next.
    }
  }
  try {
    SecureStore.setItem(slotKey(0), json);
  } catch {
    /* Out of options. The app is going down either way. */
  }
}

// Records an error. The queue write happens SYNCHRONOUSLY before anything else, so the report
// survives the process dying; the send is attempted afterwards and its failure is immaterial --
// the next launch will retry.
//
// Split in two deliberately. The write must be callable from the global handler, which cannot
// await; the send must not be, because on a fatal error there is no time for it anyway.
export function recordError(error: unknown, fatal: boolean): CrashReport {
  const report = buildReport(error, fatal);
  enqueueSync(report);
  return report;
}

export async function reportError(error: unknown, fatal: boolean): Promise<void> {
  recordError(error, fatal);
  // Send the WHOLE queue, not just this report. Sending one and then clearing every slot is how a
  // report written while the handset was out of coverage got deleted unsent by the next one that
  // happened to get through -- in the one module whose entire job is that nothing is lost.
  await flushCrashQueue();
}

// Clears only the slots whose EXACT CONTENTS were sent.
//
// Naming the slot index is not enough: a second crash during the in-flight POST overwrites slot 0
// (enqueueSync wraps), and deleting "slot 0" then throws away the newer report that was never
// sent. So the value read is compared against the value still there, and anything that changed
// underneath is left alone for the next flush. The gap between read and write is where the race
// lives -- the delete has to prove it is deleting what it read.
async function clearSent(entries: { index: number; raw: string }[]): Promise<void> {
  for (const { index, raw } of entries) {
    try {
      if (SecureStore.getItem(slotKey(index)) !== raw) continue;
      await SecureStore.deleteItemAsync(slotKey(index));
    } catch {
      /* Nothing useful to do; a stale slot is only ever re-sent, never lost. */
    }
  }
}

// `corrupt` is returned alongside, and it matters: enqueueSync counts any non-null slot as taken,
// so a slot that will not parse is occupied forever. Skipping it without ever clearing it shrinks
// the queue permanently -- four of them and every report lands in slot 0 and is overwritten by the
// next one. It carries nothing worth keeping, so the flush drops it.
export async function readQueue(): Promise<{
  entries: { index: number; raw: string; report: CrashReport }[];
  corrupt: number[];
}> {
  const entries: { index: number; raw: string; report: CrashReport }[] = [];
  const corrupt: number[] = [];
  for (let i = 0; i < SLOTS; i++) {
    let raw: string | null = null;
    try {
      raw = await SecureStore.getItemAsync(slotKey(i));
    } catch {
      continue; // Unreadable now; try again next launch rather than destroying it.
    }
    if (!raw) continue;
    try {
      entries.push({ index: i, raw, report: JSON.parse(raw) as CrashReport });
    } catch {
      corrupt.push(i);
    }
  }
  return { entries, corrupt };
}

// Sends whatever last launch could not. Called once the user is signed in, because the endpoint is
// authenticated -- reports simply wait in the queue until then.
// One flush at a time. The global handler now calls this on every error, and so do _layout's
// sign-in effect and reportError -- two overlapping flushes read the same slots and each POST the
// whole queue. recordClientErrors is a plain INSERT with no dedupe, so that shows the same crash
// two or three times on /admin/errors, and repetition is exactly the signal used to judge whether
// a loop is recurring. A latch is enough; a second caller simply joins the flush already running.
// Deliberately NOT latched against concurrent callers.
//
// A latch would stop the duplicate you get when the global handler's flush overlaps the one the
// sign-in effect fires -- but it is module state on the path whose entire job is reliability, and
// apiFetch has no timeout: one captive-portal wifi (the kind in a roof space that accepts the
// connection and answers nothing) leaves the latch held for the life of the process and every
// later report silently unsent. A duplicate row on /admin/errors is visible and harmless; a wedged
// latch is invisible and is the exact failure this module exists to end. If the duplicates ever
// matter, dedupe server-side on (occurred_at, message) -- that cannot wedge anything.
export function flushCrashQueue(): Promise<void> {
  return doFlush();
}

async function doFlush(): Promise<void> {
  const { entries, corrupt } = await readQueue();
  // Nothing to send, but a corrupt slot still has to be reclaimed or it blocks that slot forever.
  if (corrupt.length > 0) {
    for (const i of corrupt) {
      try {
        await SecureStore.deleteItemAsync(slotKey(i));
      } catch {
        /* Next launch will try again. */
      }
    }
  }
  if (entries.length === 0) return;
  try {
    await apiFetch("/api/client-errors", {
      method: "POST",
      body: JSON.stringify(entries.map((e) => e.report)),
    });
    await clearSent(entries);
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
    // Write FIRST and synchronously: `previous` is what tears the process down on a fatal error,
    // and anything still pending when it runs is lost. The send is fired off unawaited and is pure
    // bonus -- on a fatal error it will not finish, which is exactly why the write comes first.
    try {
      recordError(error, isFatal === true);
    } catch {
      /* Never let the reporter mask the error it is reporting. */
    }
    void flushCrashQueue().catch(() => {});
    previous?.(error, isFatal);
  });
}

type ErrorUtilsShape = {
  setGlobalHandler?: (fn: (error: unknown, isFatal?: boolean) => void) => void;
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
};

import { logout as apiLogout } from "./api";
import { clearToken } from "./session";

// Everything signing out has to undo, in the one order that works -- kept out of `auth.tsx` so it
// can be tested. The provider's `signOut` is the call site, and a call site that is three lines of
// React state is a call site nothing can silently lose: the first version of this lived inline in
// the provider, and deleting the entire fix left all 176 tests green.
//
// FIRST, while the session still exists: tell Twilio to stop ringing this device. The registration
// is a binding Twilio holds, not a local flag, so without this the handset keeps receiving incoming
// customer calls after logout -- and can answer them. Minting the access token that needs requires
// the session, so it cannot move after `clearToken()`. Bounded and best-effort inside
// (`unregisterFromIncoming` never throws and never hangs); logging out always completes.
//
// `./voice` is loaded LAZILY, and that is not a style choice. It constructs `new Voice()` at module
// scope, which needs the Twilio native module, so a static import here drags the whole Voice SDK
// into every module that touches auth -- and auth is imported by the root layout and by the admin
// layout. It breaks unrelated Jest suites at import time with "new NativeEventEmitter() requires a
// non-null argument", which is what that coupling looks like when the native side is absent
// (verified: a static import fails `nav.test.tsx`). By sign-out the module is long since loaded by
// the tabs layout, so this resolves from the module registry instantly.
//
// `require`, NOT a dynamic `import()`. Metro defers both the same way, but `import()` REJECTS under
// Jest -- ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG, because jest-expo does not run with
// --experimental-vm-modules. Every test of this function would therefore take the failure branch,
// silently, and still pass. That is the same shape as the tests already recorded in CLAUDE.md that
// passed against fully reverted code. Verified by running it, not assumed.
function loadLazily<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    // The module is unavailable at all (a build without the native side, or a broken registry).
    // Logging out must still work; the cost is a handset that keeps ringing, which is the
    // pre-existing behaviour.
    return null;
  }
}

// `ringingStopped` is false when the unregister failed, timed out, or could not run. The caller has
// to SAY so -- the handset will keep ringing, and the only other report of it, `regStatus`, renders
// on a Settings screen that is unmounting as this runs and is behind a login by the time it has.
export async function performSignOut(): Promise<{ ringingStopped: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const voice = loadLazily(() => require("./voice") as typeof import("./voice"));
  const ringingStopped = voice ? await voice.unregisterFromIncoming().catch(() => false) : false;

  // Same shape of problem, other channel: the Expo push token stays bound to this user until some
  // handset registers it again, and `push`'s in-process latch would stop the next sign-in on this
  // device doing so -- leaving the next staff member with no notifications of their own and this
  // user's customer-message previews still arriving here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadLazily(() => require("./push") as typeof import("./push"))?.resetPushRegistration();

  await apiLogout();
  await clearToken();
  return { ringingStopped };
}

type Nav = {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: string) => void;
};

export const SETTINGS_HREF = "/(tabs)/settings";

// Leaving the admin hub. Popping is right when there IS somewhere to pop to, which is the normal
// route in (Settings → Administration).
//
// A cold start or a deep link straight to /admin leaves an empty history, and `back()` there is a
// no-op — a button that visibly does nothing, which is a worse bug than the missing button this
// replaces, because it looks like the app has frozen. That case navigates to Settings explicitly.
export function leaveAdmin(nav: Nav): void {
  if (nav.canGoBack()) nav.back();
  else nav.replace(SETTINGS_HREF);
}

// Leaving a screen exactly once, and only while it is on top. `back()` pops whatever is on TOP, so
// leaving while covered pops the covering screen (a call ringing in, Contacts tapped) and strands
// this one; leaving twice pops the screen underneath too. Both happened on the in-call screen.
export function createScreenExit(opts: { isFocused: () => boolean; back: () => void }) {
  let left = false;
  let pending = false;
  return {
    leave() {
      if (left) return;
      if (!opts.isFocused()) {
        pending = true;
        return;
      }
      left = true;
      pending = false;
      opts.back();
    },
    onFocus() {
      if (pending) this.leave();
    },
    // Call on unmount. A screen already popped (Android hardware back) must never pop again: its
    // call's Disconnected still reaches finish(), with the last focus value it saw.
    dispose() {
      left = true;
      pending = false;
    },
  };
}

// Whether the in-call screen may be removed by navigation it did not ask for. On Android the
// hardware Back button and the edge back gesture pop it, and its unmount hangs up the call, so a
// stray Back press hung up on the customer. Only "ended" may leave: finish() sets it before
// exit.leave() runs, and End reaches it even when no call ever attached.
export function blocksLeaving(state: "calling" | "connected" | "ended"): boolean {
  return state !== "ended";
}

// After End's disconnect() rejects. Leaving closes the only in-app hang-up button, so it waits until
// the call really is disconnected. A SECOND failed End leaves anyway: with Back blocked that screen
// would otherwise have no way out, the call's own system UI (CallKit, the Android call notification)
// still offers hang-up, and the unmount retries disconnect() -- which is where Back used to leave.
export function leaveAfterFailedHangup(failures: number, callState: string): boolean {
  return callState === "disconnected" || failures >= 2;
}

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

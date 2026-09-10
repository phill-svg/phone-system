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

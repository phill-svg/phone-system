import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { createTapHandler, type NotificationRoute } from "./notificationRoute";
import { getActiveCall } from "./voice";

// What the singleton handler reads. Module scope on purpose, together with the handler: a remount of
// the root navigator (an error-boundary reset) must not forget which tap was already handled, or
// `useLastNotificationResponse` would replay the old one and drag the user back to it.
const live = { authed: false, path: "" };

function open(route: NotificationRoute): void {
  if (route.pathname === "/thread/[number]") {
    // Already reading that conversation: a second copy on the stack is only noise.
    const here = live.path.startsWith("/thread/") ? safeDecode(live.path.slice("/thread/".length)) : null;
    if (here === route.params.number) return;
    router.push(route);
  } else {
    // Tabs are switched to, not stacked.
    router.navigate(route);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const handle = createTapHandler({
  open,
  isAuthed: () => live.authed,
  // A live call, or the ringing / in-call screen (an invite that is not answered yet has no active call).
  isBlocked: () => getActiveCall() !== null || live.path.startsWith("/call-"),
});

// A cold start reaches the tap before the navigator can take a route; bounded, so it cannot spin.
const RETRY_MS = 250;
const RETRY_MAX = 8;

// Opens the screen a tapped push is about. `useLastNotificationResponse` covers all three ways in:
// a cold start from the tap, a resume, and a tap while the app is already open.
export function useNotificationTaps(authed: boolean): void {
  const last = Notifications.useLastNotificationResponse();
  const path = usePathname();
  live.authed = authed;
  live.path = path;

  // `authed` is a dependency: a tap that arrived before the session was restored is retried the
  // moment the tabs exist to navigate to.
  useEffect(() => {
    if (!last) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const attempt = () => {
      if (handle(last) === "retry" && ++attempts < RETRY_MAX) timer = setTimeout(attempt, RETRY_MS);
    };
    attempt();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [last, authed]);
}

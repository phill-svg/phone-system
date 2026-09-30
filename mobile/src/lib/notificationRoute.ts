// Where tapping a push should land. Pure -- no native import -- so jest can test it; the hook that
// feeds it real taps is `useNotificationTaps`.
//
// The push `data` is `{ type, from }` (src/api/push.ts). Nothing listened for the tap before this,
// so iOS foregrounded the app on whatever was last on screen: after a phone call that is Recents,
// whatever the notification was about.

export type NotificationRoute =
  | { pathname: "/thread/[number]"; params: { number: string } }
  | { pathname: "/(tabs)/messages" | "/(tabs)/recents" | "/(tabs)/voicemail" };

export function routeForNotification(data: unknown): NotificationRoute | null {
  if (!data || typeof data !== "object") return null;
  const { type, from } = data as { type?: unknown; from?: unknown };
  switch (type) {
    // `from` is the thread peer exactly as the server keyed it (a phone number, a Messenger id or an
    // alphanumeric sender), so it goes straight through -- normalising here would open a different,
    // empty thread, the same trap `threadPeer` exists to avoid.
    case "sms":
    case "message_failed":
      // "new" is the compose-a-new-thread screen, not a peer.
      return typeof from === "string" && from && from !== "new"
        ? { pathname: "/thread/[number]", params: { number: from } }
        : { pathname: "/(tabs)/messages" };
    case "missed_call":
      return { pathname: "/(tabs)/recents" };
    // The Inbox tab holds voicemails and callback requests side by side.
    case "voicemail":
    case "callback_request":
      return { pathname: "/(tabs)/voicemail" };
    // incoming_call has its own UI (CallKit / the ringing screen); anything unknown is left alone.
    default:
      return null;
  }
}

type TapResponse = {
  notification?: { date?: number; request?: { identifier?: string; content?: { data?: unknown } } } | null;
} | null;

// "opened" and "ignored" are final. "waiting" (not signed in yet) and "retry" (navigation was not
// ready and threw) leave the tap unhandled, so the caller tries it again.
export type TapResult = "opened" | "ignored" | "waiting" | "retry";

// One tap is handled once. The hook hands over the same response again whenever it re-renders, and
// re-navigating would drag the user back to the notification's screen every time. The key is the
// identifier AND the delivery time: a later push that reuses an identifier is a different tap.
//
// A tap with no destination, or one landing while a call screen is up, is consumed: there is
// nothing to retry, and opening a thread over a ringing or live call would bury Answer / Hang up.
export function createTapHandler(deps: {
  open: (route: NotificationRoute) => void;
  isAuthed: () => boolean;
  isBlocked: () => boolean;
}) {
  let handled: string | null = null;
  return function handle(response: TapResponse): TapResult {
    try {
      const n = response?.notification;
      const id = n?.request?.identifier;
      if (!id) return "ignored";
      const key = `${id}@${n?.date ?? ""}`;
      if (key === handled) return "ignored";
      const route = routeForNotification(n?.request?.content?.data);
      if (!route || deps.isBlocked()) {
        handled = key;
        return "ignored";
      }
      if (!deps.isAuthed()) return "waiting";
      // Marked handled only once open() has returned: a cold start can reach here before the
      // navigator exists, expo-router throws, and the tap must survive to be retried.
      deps.open(route);
      handled = key;
      return "opened";
    } catch {
      return "retry";
    }
  };
}

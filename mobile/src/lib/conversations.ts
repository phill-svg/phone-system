import type { Conversation } from "./api";

// Clears the unread badge for one conversation in a cached conversation list. Opening a thread
// marks it read on the server, so the list held by React Query is stale from that moment — this is
// what the thread screen writes back into the cache. Pure (and outside the screen) so it can be
// unit-tested; returns the list unchanged when there was nothing to clear, which keeps the array
// identity stable and saves the list a re-render.
export function markConversationRead(list: Conversation[] | undefined, number: string): Conversation[] | undefined {
  if (!list) return list;
  if (!list.some((c) => c.number === number && c.unread > 0)) return list;
  return list.map((c) => (c.number === number ? { ...c, unread: 0 } : c));
}

// Whether a thread should offer "save contact" in its header. Pure so the rules are testable:
// Messenger peers are stored as "messenger:<psid>" and have no phone number to save, a half-typed
// new thread has nothing worth saving yet, and a number we already have a name for should not be
// offered again.
export function canSaveContactFromThread(opts: {
  to: string;
  isNew: boolean;
  isMessenger: boolean;
  knownName: string | undefined;
}): boolean {
  if (opts.isNew || opts.isMessenger) return false;
  if (opts.to.trim().length <= 2) return false;
  return !opts.knownName;
}

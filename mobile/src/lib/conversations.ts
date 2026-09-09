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
  // `isNew` is the thread's own concern -- a half-typed new message has nothing worth saving yet.
  // Everything else is the shared rule, so the two screens cannot drift: they had already, with the
  // thread treating a whitespace-only stored name as a real name and Call Details not.
  if (opts.isNew) return false;
  return canSaveContact({ number: opts.isMessenger ? "messenger:" : opts.to, knownName: opts.knownName ?? "" });
}

// The one rule both screens ask: is there a real phone number here that we do not already have a
// name for?
//
// A number already in the book is not offered again (that would make a duplicate), and anything
// that is not a phone number -- a Messenger peer, a client: identity, a withheld caller ID -- has
// nothing to save. A stored name that is only whitespace is not a name.
export function canSaveContact(opts: { number: string; knownName: string }): boolean {
  const n = opts.number.trim();
  if (n.length <= 2) return false;
  if (n.startsWith("messenger:") || n.startsWith("client:")) return false;
  return !opts.knownName.trim();
}

// Whether the Call Details screen should offer "Add Contact". Saving was reachable from the keypad
// and from a message thread, but never from here -- the screen you land on from Recents, and so the
// one place you are actually looking at an unknown caller.
export const canSaveContactFromCall = canSaveContact;

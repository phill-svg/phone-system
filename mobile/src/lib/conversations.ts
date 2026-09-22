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

// The one-line status caption under an outbound bubble. Pure, so the rules are testable and so the
// web dashboard's copy of them (src/html/pages/messages.ts, msgStatusLabel) has something to be
// checked against -- the two surfaces answered "was this call missed?" differently for weeks and
// this is the same shape of question.
//
// Three rules, each with a reason:
//
// A FAILURE shows on every failed message, wherever it sits in the thread. A text that never
// arrived still matters ten messages later, and that is the behaviour #17 shipped.
//
// A POSITIVE label ("Delivered"/"Sent"/"Read") shows only under the LAST outbound message, the way
// a phone's own Messages app does it. Repeating "Delivered" under every bubble is noise people
// learn to skip, which is the same reason `divert_caller_id_last_error` clears itself and why the
// "unfinished" IVR badge covers only the types with no server-side default.
//
// A MESSENGER thread gets no positive label at all. Facebook does not report delivery back the way
// Twilio's status callback does, so every Messenger message stops at `sent` permanently -- 13 of
// them in production on 2026-09-12, the newest from 09-04. Captioning those "Sent" forever would
// read as "not delivered yet" and be wrong every single time. A Messenger FAILURE still shows: that
// one is real, and the 24-hour-window rejection is exactly what the indicator was built for.
export type MessageStatusLabel = { text: string; failed: boolean };

// Twilio's non-terminal statuses all mean the same thing to a human: we handed it over, no receipt
// yet. Listed explicitly rather than treated as a default, so a status nobody has seen before
// renders NOTHING instead of being captioned "Sent" on a guess.
const SENT_STATUSES = ["sent", "queued", "sending", "accepted", "scheduled"];

export function messageStatusLabel(opts: {
  direction: string;
  status: string | null | undefined;
  isLastOutbound: boolean;
  isMessenger: boolean;
}): MessageStatusLabel | null {
  if (opts.direction !== "outbound") return null;
  const status = (opts.status ?? "").trim().toLowerCase();
  if (status === "failed" || status === "undelivered") return { text: "Not delivered", failed: true };
  if (opts.isMessenger || !opts.isLastOutbound) return null;
  if (status === "read") return { text: "Read", failed: false };
  if (status === "delivered") return { text: "Delivered", failed: false };
  if (SENT_STATUSES.includes(status)) return { text: "Sent", failed: false };
  return null;
}

// The id of the last outbound message in a thread, or null when there is none. Separate from the
// label rule because the screen needs it once per render rather than once per row -- and because
// the thread arrives oldest-first (listThread orders `ts ASC`), which is the assumption that makes
// a backwards scan correct and is worth pinning in a test rather than leaving in a comment.
export function lastOutboundId(messages: { id: string; direction: string }[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === "outbound") return messages[i].id;
  }
  return null;
}

// When a message was sent or received, as a human reads it.
//
// Asked for as "can we get a time on the sms as well, like when we sent and received". A thread
// with no times cannot answer "did we reply before they rang?" or "how long did they wait?", which
// is the question staff actually have when they open one.
//
// Relative to NOW rather than absolute, the way a phone's own Messages app does it: a time alone is
// ambiguous the moment a thread spans two days, and a full date on every bubble in a conversation
// held this morning is noise. `now` is a parameter so this is testable without mocking the clock --
// `process.env.TZ` does nothing in this repo's test runner, a lesson already paid for here.
export function messageTimeLabel(ts: number, now: number = Date.now()): string {
  const at = new Date(ts);
  const today = new Date(now);
  const time = at
    .toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    // en-AU renders "3:42 pm" on some runtimes and "3:42 PM" on others; normalise so the thread
    // does not mix the two.
    .replace(/\s+/g, " ");
  if (at.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  // Same year: the year adds nothing. Older than that and it is the thing you are looking for.
  const sameYear = at.getFullYear() === today.getFullYear();
  const date = at.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} ${time}`;
}

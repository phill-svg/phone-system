import { markConversationRead, canSaveContactFromThread, messageStatusLabel, lastOutboundId } from "../src/lib/conversations";
import type { Conversation } from "../src/lib/api";

const list: Conversation[] = [
  { number: "+61400000001", last_body: "Hello", last_ts: 2, unread: 1 },
  { number: "+61400000002", last_body: "Hey", last_ts: 1, unread: 0 },
  { number: "messenger:123", last_body: "Ryji", last_ts: 0, unread: 3 },
];

describe("markConversationRead", () => {
  it("zeroes the unread count of the opened conversation only", () => {
    const next = markConversationRead(list, "+61400000001")!;
    expect(next.map((c) => c.unread)).toEqual([0, 0, 3]);
  });

  it("works for Messenger peers", () => {
    expect(markConversationRead(list, "messenger:123")!.map((c) => c.unread)).toEqual([1, 0, 0]);
  });

  it("leaves the list untouched when there is nothing unread to clear", () => {
    expect(markConversationRead(list, "+61400000002")).toBe(list);
    expect(markConversationRead(list, "+61499999999")).toBe(list);
  });

  it("handles an unfetched list", () => {
    expect(markConversationRead(undefined, "+61400000001")).toBeUndefined();
  });
});

describe("canSaveContactFromThread", () => {
  const base = { to: "+61400111222", isNew: false, isMessenger: false, knownName: undefined };

  it("offers it for an SMS number we have no name for", () => {
    expect(canSaveContactFromThread(base)).toBe(true);
  });

  it("does not offer it once the number is already a contact", () => {
    expect(canSaveContactFromThread({ ...base, knownName: "Jane Termite" })).toBe(false);
  });

  // Messenger peers are "messenger:<psid>" -- there is no phone number to save.
  it("never offers it on a Messenger thread", () => {
    expect(canSaveContactFromThread({ ...base, to: "messenger:123", isMessenger: true })).toBe(false);
  });

  it("does not offer it while a new thread has no usable number typed yet", () => {
    expect(canSaveContactFromThread({ ...base, to: "", isNew: true })).toBe(false);
    expect(canSaveContactFromThread({ ...base, to: "04" })).toBe(false);
  });
});

describe("messageStatusLabel", () => {
  const label = (over: Partial<Parameters<typeof messageStatusLabel>[0]> = {}) =>
    messageStatusLabel({ direction: "outbound", status: "delivered", isLastOutbound: true, isMessenger: false, ...over });

  it("captions the last outbound SMS with its delivery state", () => {
    expect(label({ status: "delivered" })).toEqual({ text: "Delivered", failed: false });
    expect(label({ status: "sent" })).toEqual({ text: "Sent", failed: false });
    expect(label({ status: "read" })).toEqual({ text: "Read", failed: false });
    expect(label({ status: "queued" })).toEqual({ text: "Sent", failed: false });
  });

  it("says nothing under an inbound message", () => {
    expect(label({ direction: "inbound" })).toBeNull();
    expect(label({ direction: "inbound", status: "failed" })).toBeNull();
  });

  // Repeating "Delivered" under every bubble is noise people learn to skip -- the same reasoning as
  // the self-clearing divert-caller-ID marker and the deliberately narrow "unfinished" IVR badge.
  it("captions only the LAST outbound message", () => {
    expect(label({ status: "delivered", isLastOutbound: false })).toBeNull();
    expect(label({ status: "sent", isLastOutbound: false })).toBeNull();
  });

  // A text that never arrived still matters ten messages later.
  it("reports a failure wherever it sits in the thread", () => {
    expect(label({ status: "failed", isLastOutbound: false })).toEqual({ text: "Not delivered", failed: true });
    expect(label({ status: "undelivered", isLastOutbound: false })).toEqual({ text: "Not delivered", failed: true });
  });

  // Facebook never reports delivery back the way Twilio's status callback does, so every Messenger
  // message stops at `sent` permanently. Captioning those "Sent" forever would read as "not
  // delivered yet" and be wrong every single time.
  it("never captions a Messenger message as sent or delivered", () => {
    expect(label({ status: "sent", isMessenger: true })).toBeNull();
    expect(label({ status: "delivered", isMessenger: true })).toBeNull();
    expect(label({ status: "read", isMessenger: true })).toBeNull();
  });

  it("still reports a Messenger failure, which is the 24-hour-window rejection", () => {
    expect(label({ status: "failed", isMessenger: true, isLastOutbound: false })).toEqual({
      text: "Not delivered",
      failed: true,
    });
  });

  it("says nothing for a status it does not recognise, rather than guessing 'Sent'", () => {
    expect(label({ status: null })).toBeNull();
    expect(label({ status: undefined })).toBeNull();
    expect(label({ status: "" })).toBeNull();
    expect(label({ status: "something_twilio_added_later" })).toBeNull();
  });

  it("is case- and whitespace-insensitive about the stored status", () => {
    expect(label({ status: " Delivered " })).toEqual({ text: "Delivered", failed: false });
    expect(label({ status: "FAILED" })).toEqual({ text: "Not delivered", failed: true });
  });

  // The web dashboard renders the same rules from its own copy (src/html/pages/messages.ts,
  // msgStatusLabel, pinned in test/html/messagesStatus.test.ts). The two surfaces already drifted
  // once on "was this call missed?"; these two suites are what stop it happening again.
  it("matches the rule the web dashboard implements", () => {
    expect(label({ status: "delivered" })?.text).toBe("Delivered");
  });
});

describe("lastOutboundId", () => {
  // listThread orders `ts ASC`, so the thread arrives oldest-first and the last outbound is found by
  // scanning backwards. Pinned rather than left as a comment, because the whole caption hangs on it.
  it("finds the final outbound in a thread that ends with an inbound reply", () => {
    expect(
      lastOutboundId([
        { id: "a", direction: "inbound" },
        { id: "b", direction: "outbound" },
        { id: "c", direction: "inbound" },
      ])
    ).toBe("b");
  });

  it("returns null when the customer has only ever written to us", () => {
    expect(lastOutboundId([{ id: "a", direction: "inbound" }])).toBeNull();
    expect(lastOutboundId([])).toBeNull();
    expect(lastOutboundId(undefined)).toBeNull();
  });
});

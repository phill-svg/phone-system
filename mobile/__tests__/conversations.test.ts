import { markConversationRead, canSaveContactFromThread } from "../src/lib/conversations";
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

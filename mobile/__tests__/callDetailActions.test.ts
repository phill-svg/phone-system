/// <reference types="jest" />

import { canSaveContactFromCall } from "../src/lib/conversations";

// Saving a contact was reachable from the keypad and from a message thread, but never from Call
// Details -- the screen you land on from Recents, and so the one place you are actually looking at
// an unknown caller.
describe("offering Add Contact on Call Details", () => {
  it("offers it for an unknown number", () => {
    expect(canSaveContactFromCall({ number: "+61490859438", knownName: "" })).toBe(true);
  });

  // Offering it for somebody already saved is noise, and tapping it would make a duplicate.
  it("does not offer it for a number already in the book", () => {
    expect(canSaveContactFromCall({ number: "+61490859438", knownName: "Robbie Stevenson" })).toBe(false);
  });

  // A blank-looking name is not a name -- still worth offering to save.
  it("still offers it when the stored name is only whitespace", () => {
    expect(canSaveContactFromCall({ number: "+61490859438", knownName: "   " })).toBe(true);
  });

  // A withheld caller ID, or a peer that is not a phone number at all, has nothing to save.
  it("does not offer it when there is no usable number", () => {
    expect(canSaveContactFromCall({ number: "", knownName: "" })).toBe(false);
    expect(canSaveContactFromCall({ number: "messenger:12345", knownName: "" })).toBe(false);
    expect(canSaveContactFromCall({ number: "client:phill@b.com", knownName: "" })).toBe(false);
  });
});

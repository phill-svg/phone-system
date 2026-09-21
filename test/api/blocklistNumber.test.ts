import { describe, expect, it } from "vitest";
import { blocklistNumber } from "../../src/api/blocklistNumber";

// The blocklist has exactly one consumer: src/worker.ts compares it LITERALLY against Twilio's
// `From` on an inbound call. An entry in any other shape blocks nobody, forever, while sitting on
// the screen looking exactly like one that works. This is the rule that decides, and it lives on
// the server because BOTH clients write this list and they used to disagree.

describe("blocklistNumber", () => {
  it("stores an Australian number the way Twilio reports it, however it was typed", () => {
    for (const raw of ["0400 123 456", "+61400123456", "0400123456", "+61 400 123 456", "0400.123.456"]) {
      expect(blocklistNumber(raw)).toBe("+61400123456");
    }
  });

  it("handles the shapes a landline is copied in", () => {
    expect(blocklistNumber("02 6105 9771")).toBe("+61261059771");
    expect(blocklistNumber("(02) 6105 9771")).toBe("+61261059771");
  });

  // 1300/1800/13xx carry no trunk 0, so a rule built on stripping a leading zero drops them.
  it("keeps 1300, 1800 and 13xx numbers Australian", () => {
    expect(blocklistNumber("1300 123 456")).toBe("+611300123456");
    expect(blocklistNumber("1800 123 456")).toBe("+611800123456");
    expect(blocklistNumber("13 2221")).toBe("+61132221");
  });

  // The defect this whole rule exists for: one keystroke short is not a number. Stored, it blocks
  // nobody while reading on screen exactly like an entry that works.
  it("refuses a number that is one digit short, or one too long", () => {
    expect(blocklistNumber("02 6105 977")).toBeNull();
    expect(blocklistNumber("0400 123 45")).toBeNull();
    expect(blocklistNumber("02 6105 97711")).toBeNull();
  });

  // 1300 is carved OUT of the 13 range, so the first six digits of a 1300 number are not a
  // finished 13xxxx one.
  it("refuses the first six digits of a 1300 number", () => {
    expect(blocklistNumber("1300 12")).toBeNull();
  });

  // An overseas scam caller is an ordinary thing to want blocked, and no AU rule can judge one.
  it("accepts an international number, and refuses a prefix of one", () => {
    expect(blocklistNumber("+1 555 123 4567")).toBe("+15551234567");
    expect(blocklistNumber("+1 555 1234")).toBeNull();
  });

  // The "+" must not let an Australian number skip the Australian rules -- including with a space
  // after it, which is how a number pasted from a contact card often arrives.
  it("applies the Australian rules to +61 however it is spaced", () => {
    expect(blocklistNumber("+ 61 2 6105 977")).toBeNull();
    expect(blocklistNumber("+(61) 2 6105 9771")).toBe("+61261059771");
  });

  // A voice call's From is never alphanumeric, so a sender ID would add a row that can never match.
  it("refuses anything with letters, and anything with no digits", () => {
    expect(blocklistNumber("SERVICE-NSW")).toBeNull();
    expect(blocklistNumber("Optus1")).toBeNull();
    expect(blocklistNumber("+")).toBeNull();
    expect(blocklistNumber("()")).toBeNull();
    expect(blocklistNumber("   ")).toBeNull();
  });

  // E.164 allows at most 15 digits; beyond that it is not a number anyone can call.
  it("refuses more digits than E.164 allows", () => {
    expect(blocklistNumber("+1234567890123456")).toBeNull();
  });
});

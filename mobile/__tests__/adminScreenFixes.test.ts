import { loadFlowOrEmpty, type IvrFlow } from "../src/lib/ivr";
import { blocklistNumber, blocklistState, withPendingEntry } from "../src/lib/phone";

// Defects found by an adversarial scan of the admin screens on 2026-09-22, and the review rounds
// that followed. Both originals were shapes this repo has hit before: a client feature the server
// refuses, and a draft the Save button silently discards.

describe("loadFlowOrEmpty", () => {
  const flow: IvrFlow = { entryNodeId: "n1", nodes: [] };

  it("returns the flow when it loads", async () => {
    expect(await loadFlowOrEmpty(async () => flow)).toBe(flow);
  });

  // `GET /api/ivr/flows/:flow` 404s a flow with no rows, and a menu the admin has just named always
  // has none -- so treating 404 as an error made "Create a new menu" impossible: the screen's error
  // branch returns before both the switcher and the Add-a-step control, so the first step could
  // never be added and there was no way back to `main`.
  it("treats 404 as an empty menu, so a brand-new one can get its first step", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    expect(
      await loadFlowOrEmpty(async () => {
        throw notFound;
      })
    ).toEqual({ entryNodeId: null, nodes: [] });
  });

  // A 500 or a dropped connection must NOT present itself as a blank menu: an admin could "fix" it
  // by rebuilding steps that already exist, and the save would then wipe the real ones.
  it("rethrows anything that is not a 404", async () => {
    for (const status of [500, 403, undefined]) {
      const err = Object.assign(new Error("boom"), status === undefined ? {} : { status });
      await expect(
        loadFlowOrEmpty(async () => {
          throw err;
        })
      ).rejects.toBe(err);
    }
  });
});

// Mirrors `src/api/blocklistNumber.ts`, which is authoritative -- the server normalises and
// validates every entry. This copy only decides whether Save is enabled, so the two must agree;
// `test/api/blocklistNumber.test.ts` is the same table on the other side.
describe("blocklistNumber", () => {
  it("stores an Australian number the way Twilio reports it, however it was typed", () => {
    for (const raw of ["0400 123 456", "+61400123456", "0400123456", "0400.123.456"]) {
      expect(blocklistNumber(raw)).toBe("+61400123456");
    }
    expect(blocklistNumber("(02) 6105 9771")).toBe("+61261059771");
  });

  it("keeps 1300, 1800 and 13xx numbers Australian", () => {
    expect(blocklistNumber("1300 123 456")).toBe("+611300123456");
    expect(blocklistNumber("13 2221")).toBe("+61132221");
  });

  // The defect the whole rule exists for: one keystroke short is not a number, and stored it blocks
  // nobody while reading on screen exactly like an entry that works.
  it("refuses a half-typed number", () => {
    expect(blocklistNumber("02 6105 977")).toBeNull();
    expect(blocklistNumber("0400 123 45")).toBeNull();
    expect(blocklistNumber("0")).toBeNull();
  });

  // 1300 is carved OUT of the 13 range, so the first six digits of a 1300 number are not a finished
  // 13xxxx one.
  it("refuses the first six digits of a 1300 number", () => {
    expect(blocklistNumber("1300 12")).toBeNull();
  });

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
  it("refuses letters, and punctuation with no digits", () => {
    expect(blocklistNumber("SERVICE-NSW")).toBeNull();
    expect(blocklistNumber("Optus1")).toBeNull();
    expect(blocklistNumber("+")).toBeNull();
    expect(blocklistNumber("   ")).toBeNull();
  });
});

describe("withPendingEntry", () => {
  // The original defect: typing a number and tapping Save without tapping + discarded it, while the
  // button read "Saved" -- so the admin believed a caller was blocked who was not. The ScrollView
  // sets keyboardShouldPersistTaps="handled", so tapping Save never blurs the field either.
  it("includes a complete number still sitting in the entry box", () => {
    expect(withPendingEntry(["+61400000000"], "0400 123 456")).toEqual(["+61400000000", "+61400123456"]);
  });

  it("returns the list untouched when the box is empty or half-typed", () => {
    const list = ["+61400000000"];
    expect(withPendingEntry(list, "")).toBe(list);
    expect(withPendingEntry(list, "   ")).toBe(list);
    expect(withPendingEntry(list, "02 6105 977")).toBe(list);
  });

  // A duplicate row would share a React key, and one tap on remove would delete both.
  it("does not duplicate a number that is already blocked", () => {
    const list = ["+61400123456"];
    expect(withPendingEntry(list, "0400 123 456")).toBe(list);
  });
});

describe("blocklistState", () => {
  // The payload and `dirty` were computed separately, and that disagreement WAS the bug: Save sat
  // disabled reading "Saved" while the entry box held a number nobody had added.
  it("enables Save for a complete number sitting in the entry box", () => {
    const state = blocklistState(["+61400000000"], ["+61400000000"], "0400 123 456");
    expect(state.dirty).toBe(true);
    expect(state.pending).toEqual(["+61400000000", "+61400123456"]);
  });

  it("keeps Save disabled while the entry is still half-typed", () => {
    const state = blocklistState(["+61400000000"], ["+61400000000"], "0400 123");
    expect(state.dirty).toBe(false);
    expect(state.pending).toEqual(["+61400000000"]);
  });

  it("enables Save when a number was removed from the list", () => {
    expect(blocklistState(["+61400000000"], [], "").dirty).toBe(true);
  });

  it("is never dirty before the saved list has loaded", () => {
    expect(blocklistState(null, [], "0400 123 456").dirty).toBe(false);
  });
});

import { loadFlowOrEmpty, type IvrFlow } from "../src/lib/ivr";
import { blocklistState, isCompleteAuNumber, normalizeBlocklistEntry, withPendingEntry } from "../src/lib/phone";

// Two defects found by an adversarial scan of the admin screens on 2026-09-22. Both are the same
// shape the repo has hit before: a client feature the server refuses, and a draft the Save button
// silently discards.

describe("loadFlowOrEmpty", () => {
  const flow: IvrFlow = { entryNodeId: "n1", nodes: [] };

  it("returns the flow when it loads", async () => {
    expect(await loadFlowOrEmpty(async () => flow)).toBe(flow);
  });

  // `GET /api/ivr/flows/:flow` 404s a flow with no rows, and a menu the admin has just named
  // always has none -- so treating 404 as an error made "Create a new menu" impossible: the
  // screen's error branch returns before both the switcher and the Add-a-step control, so the
  // first step could never be added and there was no way back to `main`.
  it("treats 404 as an empty menu, so a brand-new one can get its first step", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    expect(
      await loadFlowOrEmpty(async () => {
        throw notFound;
      })
    ).toEqual({ entryNodeId: null, nodes: [] });
  });

  // A 500 or a dropped connection must NOT present itself as a blank menu: an admin could
  // "fix" it by rebuilding steps that already exist, and the save would then wipe the real ones.
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

describe("normalizeBlocklistEntry", () => {
  // The IVR compares the list LITERALLY against Twilio's `From`, which is E.164.
  it("stores an Australian number the way Twilio reports it", () => {
    expect(normalizeBlocklistEntry("0400 123 456")).toBe("+61400123456");
    expect(normalizeBlocklistEntry("  +61400123456 ")).toBe("+61400123456");
  });

  // A short code or alphanumeric sender is still something an admin may want to block; mangling it
  // would store something that matches nothing.
  it("keeps anything it cannot parse verbatim", () => {
    expect(normalizeBlocklistEntry("SERVICE-NSW")).toBe("SERVICE-NSW");
  });
});

describe("withPendingEntry", () => {
  // The defect: typing a number and tapping Save without tapping + discarded it, while the button
  // read "Saved" -- so the admin believed a caller was blocked who was not. The ScrollView sets
  // keyboardShouldPersistTaps="handled", so tapping Save never blurs the field either.
  it("includes a number still sitting in the entry box", () => {
    expect(withPendingEntry(["+61400000000"], "0400 123 456")).toEqual(["+61400000000", "+61400123456"]);
  });

  it("returns the list untouched when the box is empty", () => {
    const list = ["+61400000000"];
    expect(withPendingEntry(list, "")).toBe(list);
    expect(withPendingEntry(list, "   ")).toBe(list);
  });

  // The same number may already be on the list; adding it twice would render a duplicate row with
  // a duplicate React key and let one tap on remove delete both.
  it("does not duplicate a number that is already blocked", () => {
    const list = ["+61400123456"];
    expect(withPendingEntry(list, "0400 123 456")).toBe(list);
  });
});

// The first fix for the dropped-number bug re-opened it from the other side: folding the entry box
// into the saved list meant a HALF-TYPED number got committed too, and `toE164` validates nothing,
// so "02 6105 977" became "+6126105977" -- a number that blocks nobody while reading on screen
// exactly like one that does. Prefix-freedom, the rule TimeField already uses.
describe("isCompleteAuNumber", () => {
  it("accepts every shape the business actually dials", () => {
    for (const n of ["0400 123 456", "+61400123456", "02 6105 9771", "1300 123 456", "13 2221"]) {
      expect(isCompleteAuNumber(n)).toBe(true);
    }
  });

  it("rejects a number one digit short, and one digit long", () => {
    expect(isCompleteAuNumber("02 6105 977")).toBe(false);
    expect(isCompleteAuNumber("02 6105 97711")).toBe(false);
    expect(isCompleteAuNumber("0400 123 45")).toBe(false);
  });

  it("rejects a bare area code and a lone zero", () => {
    expect(isCompleteAuNumber("02")).toBe(false);
    expect(isCompleteAuNumber("0")).toBe(false);
    expect(isCompleteAuNumber("")).toBe(false);
  });
});

describe("withPendingEntry, half-typed entries", () => {
  // The whole point: an interrupted admin must not have a useless number written to the live list.
  it("leaves an incomplete number in the box rather than saving it", () => {
    const list = ["+61400000000"];
    expect(withPendingEntry(list, "02 6105 977")).toBe(list);
    expect(withPendingEntry(list, "04")).toBe(list);
  });

  // A short code or alphanumeric sender has no "complete" length to check, and blocking one is a
  // real thing to want.
  it("still folds in an entry with no digits at all", () => {
    expect(withPendingEntry([], "SERVICE-NSW")).toEqual(["SERVICE-NSW"]);
  });
});

describe("blocklistState", () => {
  // The two were computed separately, and that disagreement WAS the bug: Save sat disabled reading
  // "Saved" while the entry box held a number nobody had added. One function, both answers.
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

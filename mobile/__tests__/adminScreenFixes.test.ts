import { loadFlowOrEmpty, type IvrFlow } from "../src/lib/ivr";
import { normalizeBlocklistEntry, withPendingEntry } from "../src/lib/phone";

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

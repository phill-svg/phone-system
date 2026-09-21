import { searchCalls } from "../src/lib/phone";

// Recents holds up to 2000 calls, so "find that call from last Tuesday" was scrolling. The rule
// that matters: a row whose visible text contains what you typed must never be hidden.

type Row = { id: string; direction: string; caller_number: string; called_number: string };

const inbound = (id: string, from: string): Row => ({
  id,
  direction: "inbound",
  caller_number: from,
  called_number: "+61261059771",
});
const outbound = (id: string, to: string): Row => ({
  id,
  direction: "outbound",
  caller_number: "+61261059771",
  called_number: to,
});

const names: Record<string, string> = { c1: "Mrs Dixon", c2: "Bunnings Tuggeranong" };
const nameFor = (c: Row) => names[c.id] ?? "";

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("searchCalls", () => {
  const calls = [inbound("c1", "+61402430107"), outbound("c2", "+61262931122"), inbound("c3", "+61411222333")];

  it("returns everything for an empty query, including whitespace", () => {
    expect(ids(searchCalls("", calls, nameFor))).toEqual(["c1", "c2", "c3"]);
    expect(ids(searchCalls("   ", calls, nameFor))).toEqual(["c1", "c2", "c3"]);
  });

  it("matches the saved contact name, case-insensitively and part-way through", () => {
    expect(ids(searchCalls("dixon", calls, nameFor))).toEqual(["c1"]);
    expect(ids(searchCalls("tugger", calls, nameFor))).toEqual(["c2"]);
  });

  // The number is stored one way, displayed another, and typed a third. All three have to find it,
  // or the search looks broken to whoever typed the number off the screen in front of them.
  it("matches a number however it is typed", () => {
    for (const query of ["0402430107", "402430107", "+61402430107", "0402 430 107"]) {
      expect(ids(searchCalls(query, calls, nameFor))).toEqual(["c1"]);
    }
  });

  // An outbound call's other party is `called_number`; reading `caller_number` for both would make
  // every outbound call match the business's own number and nothing else.
  it("searches the OTHER party, which differs by direction", () => {
    expect(ids(searchCalls("62931122", calls, nameFor))).toEqual(["c2"]);
    // The business number is on every row and must not match everything.
    expect(ids(searchCalls("61059771", calls, nameFor))).toEqual([]);
  });

  it("finds nothing when nothing matches", () => {
    expect(ids(searchCalls("zzz", calls, nameFor))).toEqual([]);
  });

  // One digit matches most of a call log, which is not a search result -- it is the list again.
  it("ignores a single typed digit as a number search", () => {
    expect(ids(searchCalls("4", calls, nameFor))).toEqual([]);
  });

  // A call with no saved contact still has a number, and that is usually what you remember.
  it("matches a number on a call that has no contact name", () => {
    expect(ids(searchCalls("411222333", calls, nameFor))).toEqual(["c3"]);
  });
});

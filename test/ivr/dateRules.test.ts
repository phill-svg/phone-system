import { describe, expect, it } from "vitest";
import { isClosedDate, isValidClosedDateEntry } from "../../src/ivr/dateRules";

describe("isClosedDate", () => {
  it("matches an exact YYYY-MM-DD date (Australia/Sydney)", () => {
    expect(isClosedDate(["2026-12-25"], new Date("2026-12-25T02:00:00Z"))).toBe(true);
    expect(isClosedDate(["2026-12-25"], new Date("2026-12-26T02:00:00Z"))).toBe(false);
  });

  it("matches a recurring MM-DD date every year", () => {
    expect(isClosedDate(["12-25"], new Date("2027-12-25T02:00:00Z"))).toBe(true);
    expect(isClosedDate(["01-26"], new Date("2026-01-26T02:00:00Z"))).toBe(true);
    expect(isClosedDate(["01-26"], new Date("2026-01-27T02:00:00Z"))).toBe(false);
  });

  it("matches an inclusive date range", () => {
    const range = ["2026-12-24..2027-01-02"];
    expect(isClosedDate(range, new Date("2026-12-31T02:00:00Z"))).toBe(true);
    expect(isClosedDate(range, new Date("2027-01-02T02:00:00Z"))).toBe(true);
    expect(isClosedDate(range, new Date("2027-01-03T02:00:00Z"))).toBe(false);
  });

  it("returns false for an empty or missing list", () => {
    expect(isClosedDate([], new Date())).toBe(false);
    expect(isClosedDate(undefined, new Date())).toBe(false);
    expect(isClosedDate(null, new Date())).toBe(false);
  });

  it("respects the Sydney timezone at the UTC day boundary", () => {
    // 2026-12-24 14:30 UTC is already 2026-12-25 01:30 in Sydney (UTC+11 in December).
    expect(isClosedDate(["2026-12-25"], new Date("2026-12-24T14:30:00Z"))).toBe(true);
  });
});

// The bare MM-DD form is supported, so MM-DD..MM-DD is the obvious way to write a shutdown. It
// could never match: the range branch compared against YYYY-MM-DD, and "2026-12-27" <= "12-31" is
// already false on the first character. The IVR stayed open every day of the closure.
describe("recurring closed-date ranges", () => {
  const at = (iso: string) => new Date(iso);

  it("matches a recurring MM-DD..MM-DD range", () => {
    expect(isClosedDate(["12-24..12-31"], at("2026-12-27T02:00:00.000Z"))).toBe(true);
    expect(isClosedDate(["12-24..12-31"], at("2026-12-20T02:00:00.000Z"))).toBe(false);
  });

  // A shutdown over the new year is two ranges, not one, under string comparison.
  it("matches a recurring range that wraps the new year", () => {
    expect(isClosedDate(["12-24..01-02"], at("2026-12-27T02:00:00.000Z"))).toBe(true);
    expect(isClosedDate(["12-24..01-02"], at("2027-01-01T02:00:00.000Z"))).toBe(true);
    expect(isClosedDate(["12-24..01-02"], at("2026-06-01T02:00:00.000Z"))).toBe(false);
  });

  it("still matches a full-date range", () => {
    expect(isClosedDate(["2026-12-24..2026-12-31"], at("2026-12-27T02:00:00.000Z"))).toBe(true);
  });
});

// Unrecognised entries are skipped at match time -- refusing to answer calls over a typo would be
// worse -- so the validation has to happen where someone can still see it.
describe("isValidClosedDateEntry", () => {
  it("accepts the forms the matcher can act on", () => {
    expect(isValidClosedDateEntry("2026-12-25")).toBe(true);
    expect(isValidClosedDateEntry("12-25")).toBe(true);
    expect(isValidClosedDateEntry("12-24..01-02")).toBe(true);
    expect(isValidClosedDateEntry("2026-12-24..2026-12-31")).toBe(true);
  });

  it("refuses what would silently be ignored", () => {
    expect(isValidClosedDateEntry("25 December")).toBe(false);
    expect(isValidClosedDateEntry("2026/12/25")).toBe(false);
    expect(isValidClosedDateEntry("")).toBe(false);
    // Mixed kinds: comparing MM-DD against YYYY-MM-DD is meaningless in either direction.
    expect(isValidClosedDateEntry("12-24..2026-12-31")).toBe(false);
  });

  // The digit shape alone admits the typos most likely to be made: a day-first Christmas, and a
  // month that does not exist. Both save cleanly and can never match -- the same silent no-op as
  // an unreadable entry, reached by a different door.
  it("refuses digits that are not a real date", () => {
    expect(isValidClosedDateEntry("25-12")).toBe(false);
    expect(isValidClosedDateEntry("2026-13-01")).toBe(false);
    expect(isValidClosedDateEntry("12-32")).toBe(false);
    // An inverted full-date range matches nothing, silently.
    expect(isValidClosedDateEntry("2026-12-31..2026-12-24")).toBe(false);
    // 29 Feb is real, and a recurring entry has no year to check it against.
    expect(isValidClosedDateEntry("02-29")).toBe(true);
  });
});

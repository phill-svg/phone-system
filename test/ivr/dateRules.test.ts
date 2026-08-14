import { describe, expect, it } from "vitest";
import { isClosedDate } from "../../src/ivr/dateRules";

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

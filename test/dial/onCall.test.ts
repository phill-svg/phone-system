import { describe, it, expect } from "vitest";
import { isWeekStartKey, rotationMemberFor, weekStartKey, weeksBetween } from "../../src/dial/onCall";

describe("weekStartKey", () => {
  // The whole reason the date is resolved in Sydney BEFORE the arithmetic. Monday 09:00 in Canberra
  // is Sunday 23:00 UTC, so anything that reads the UTC weekday first counts this call into the
  // PREVIOUS week and rings last week's tech. Australia is far enough ahead that this is not an
  // edge case -- it is most of every Monday morning.
  it("counts a Monday morning in Canberra as that Monday, not the day before", () => {
    expect(weekStartKey(new Date("2026-09-06T23:00:00Z"))).toBe("2026-09-07"); // Mon 09:00 Sydney
  });

  // And the mirror: Sunday evening Sydney is still Sunday UTC-morning, and belongs to the week that
  // is ending, not the one about to start.
  it("counts Sunday night in Canberra as the week that is ending", () => {
    expect(weekStartKey(new Date("2026-09-13T11:00:00Z"))).toBe("2026-09-07"); // Sun 21:00 Sydney
    expect(weekStartKey(new Date("2026-09-13T14:00:00Z"))).toBe("2026-09-14"); // Mon 00:00 Sydney
  });

  it("returns the same Monday from every day of that week", () => {
    const keys = [
      "2026-09-07T02:00:00Z", "2026-09-09T02:00:00Z", "2026-09-11T02:00:00Z", "2026-09-13T02:00:00Z",
    ].map((iso) => weekStartKey(new Date(iso)));
    expect(new Set(keys)).toEqual(new Set(["2026-09-07"]));
  });

  // Sydney moves to daylight saving on the first Sunday in October. The arithmetic runs in UTC on a
  // bare calendar date precisely so a 23-hour local day cannot shift a week boundary.
  it("is unmoved by the daylight-saving change", () => {
    // AEDT begins 02:00 on Sunday 4 October 2026, mid-week. The Sunday after the clocks go forward
    // must still belong to the week that began Monday 28 September, and the next Monday must start
    // a new one -- a 23-hour local day inside the week may not move either boundary.
    expect(weekStartKey(new Date("2026-10-03T23:00:00Z"))).toBe("2026-09-28"); // Sun 4 Oct, 10:00 AEDT
    expect(weekStartKey(new Date("2026-10-04T23:00:00Z"))).toBe("2026-10-05"); // Mon 5 Oct, 10:00 AEDT
  });
});

describe("isWeekStartKey", () => {
  it("accepts a Monday and refuses any other day", () => {
    expect(isWeekStartKey("2026-09-07")).toBe(true);
    // A Tuesday anchor would shift every rotation boundary by a day, forever, silently.
    expect(isWeekStartKey("2026-09-08")).toBe(false);
    expect(isWeekStartKey("07-09-2026")).toBe(false);
    expect(isWeekStartKey("2026-13-07")).toBe(false);
  });
});

describe("rotationMemberFor", () => {
  const rotation = { members: ["a@x.com", "b@x.com", "c@x.com"], anchorWeekStart: "2026-09-07" };

  it("advances one person per week and wraps", () => {
    expect(rotationMemberFor(rotation, "2026-09-07")).toBe("a@x.com");
    expect(rotationMemberFor(rotation, "2026-09-14")).toBe("b@x.com");
    expect(rotationMemberFor(rotation, "2026-09-21")).toBe("c@x.com");
    expect(rotationMemberFor(rotation, "2026-09-28")).toBe("a@x.com");
  });

  // An anchor set to NEXT Monday is an ordinary thing to do ("start the new rota on the 14th"), and
  // a raw modulo would give this week a negative index and resolve to undefined -- leaving tonight
  // uncovered with nothing saying why.
  it("still resolves weeks before the anchor", () => {
    expect(rotationMemberFor(rotation, "2026-08-31")).toBe("c@x.com");
    expect(rotationMemberFor(rotation, "2026-08-24")).toBe("b@x.com");
  });

  it("is nobody when the rotation is empty or unanchored", () => {
    expect(rotationMemberFor({ members: [], anchorWeekStart: "" }, "2026-09-07")).toBeNull();
    expect(rotationMemberFor({ members: ["a@x.com"], anchorWeekStart: "" }, "2026-09-07")).toBeNull();
  });

  it("keeps a single-member rotation on that person forever", () => {
    const solo = { members: ["only@x.com"], anchorWeekStart: "2026-09-07" };
    expect(rotationMemberFor(solo, "2026-09-07")).toBe("only@x.com");
    expect(rotationMemberFor(solo, "2027-04-05")).toBe("only@x.com");
  });
});

describe("weeksBetween", () => {
  it("counts whole weeks across a daylight-saving change", () => {
    // 28 Sep is AEST, 12 Oct is AEDT: 14 calendar days containing a 23-hour local day.
    expect(weeksBetween("2026-09-28", "2026-10-12")).toBe(2);
    expect(weeksBetween("2026-10-12", "2026-09-28")).toBe(-2);
  });
});

describe("weekStartKey on an unrecognised weekday", () => {
  // `?? 0` here would treat any unknown token as Monday, so every call resolved its own calendar
  // date as a "week start" -- not a Monday, so weeksBetween returns a fraction, Math.round snaps it
  // arbitrarily, and the rota names a semi-random person. isWeekStartKey never catches it because
  // it only validates the ANCHOR. Throwing is caught by every caller as "nobody on call", which
  // falls through to voicemail: wrong, but loudly and safely wrong.
  it("throws rather than silently treating the day as Monday", () => {
    const real = Intl.DateTimeFormat;
    // @ts-expect-error -- deliberately returning a weekday token outside the map.
    Intl.DateTimeFormat = function () {
      return {
        formatToParts: () => [
          { type: "year", value: "2026" },
          { type: "month", value: "09" },
          { type: "day", value: "10" },
          { type: "weekday", value: "Donnerstag" },
        ],
      };
    };
    try {
      expect(() => weekStartKey(new Date("2026-09-10T00:00:00Z"))).toThrow(/unrecognised weekday/);
    } finally {
      Intl.DateTimeFormat = real;
    }
  });
});

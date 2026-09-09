import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, type BusinessHoursSchedule, isDayWindow } from "../../src/ivr/businessHours";

const schedule: BusinessHoursSchedule = {
  mon: { open: "07:00", close: "17:00" },
  tue: { open: "07:00", close: "17:00" },
  wed: { open: "07:00", close: "17:00" },
  thu: { open: "07:00", close: "17:00" },
  fri: { open: "07:00", close: "17:00" },
  sat: { open: "08:00", close: "12:00" },
  sun: null,
};

// All test times are UTC instants that land on the stated local (Australia/Sydney) day/time.
describe("isWithinBusinessHours", () => {
  it("is true mid-morning on a weekday", () => {
    // Wed 2026-08-05 10:00 Australia/Sydney (AEST, UTC+10) = 2026-08-05T00:00:00Z
    expect(isWithinBusinessHours(schedule, new Date("2026-08-05T00:00:00Z"))).toBe(true);
  });

  it("is false before opening on a weekday", () => {
    // Wed 06:59 Australia/Sydney = Tue 20:59Z
    expect(isWithinBusinessHours(schedule, new Date("2026-08-04T20:59:00Z"))).toBe(false);
  });

  it("is true exactly at opening time (inclusive)", () => {
    expect(isWithinBusinessHours(schedule, new Date("2026-08-04T21:00:00Z"))).toBe(true);
  });

  it("is false exactly at closing time (exclusive)", () => {
    // Wed 17:00 Australia/Sydney = Wed 07:00Z
    expect(isWithinBusinessHours(schedule, new Date("2026-08-05T07:00:00Z"))).toBe(false);
  });

  it("is false on a day marked closed (Sunday)", () => {
    expect(isWithinBusinessHours(schedule, new Date("2026-08-09T02:00:00Z"))).toBe(false);
  });

  it("uses the Saturday-specific window", () => {
    // Sat 11:00 Australia/Sydney = Sat 01:00Z — within 08:00-12:00
    expect(isWithinBusinessHours(schedule, new Date("2026-08-08T01:00:00Z"))).toBe(true);
    // Sat 13:00 Australia/Sydney = Sat 03:00Z — after close
    expect(isWithinBusinessHours(schedule, new Date("2026-08-08T03:00:00Z"))).toBe(false);
  });
});

// isWithinBusinessHours is `minutes >= open && minutes < close`, and nothing checked that the day
// was open at any point. A window saved as 09:00-00:00 -- the natural way to write "until midnight"
// -- reads as CLOSED ALL DAY: every in-hours call routed to after-hours and that person dropped off
// the ring roster, while the schedule screen showed hours that look perfectly correct.
describe("isDayWindow", () => {
  it("accepts an ordinary window", () => {
    expect(isDayWindow({ open: "09:00", close: "17:00" })).toBe(true);
    expect(isDayWindow(null)).toBe(true);
  });

  it("refuses a window nobody can be reached in", () => {
    expect(isDayWindow({ open: "17:00", close: "09:00" })).toBe(false);
    expect(isDayWindow({ open: "09:00", close: "09:00" })).toBe(false);
    expect(isDayWindow([])).toBe(false);
  });

  // Rejecting this outright would have been a worse fix than the bug: "until midnight" is a real
  // closing time and 00:00 is the natural way to write it. It has to MEAN end-of-day in both the
  // validator and the matcher, or the day reads as closed all day again.
  it("reads a close of 00:00 as midnight, not as minute zero", () => {
    expect(isDayWindow({ open: "09:00", close: "00:00" })).toBe(true);
    const untilMidnight = {
      mon: { open: "09:00", close: "00:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
    };
    // Mon 23:00 Australia/Sydney.
    expect(isWithinBusinessHours(untilMidnight, new Date("2026-08-10T13:00:00.000Z"))).toBe(true);
    // Mon 08:00 -- before opening, still closed.
    expect(isWithinBusinessHours(untilMidnight, new Date("2026-08-09T22:00:00.000Z"))).toBe(false);
  });

  // The old shape check was `\d{2}:\d{2}`, which admits these -- and toMinutes("99:99") is 6039,
  // past any real time of day, so the day reads as closed just the same.
  it("refuses a time that is not a time", () => {
    expect(isDayWindow({ open: "99:99", close: "99:99" })).toBe(false);
    expect(isDayWindow({ open: "24:00", close: "25:00" })).toBe(false);
    expect(isDayWindow({ open: "9:00", close: "17:00" })).toBe(false);
  });
});

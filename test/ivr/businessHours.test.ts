import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, type BusinessHoursSchedule } from "../../src/ivr/businessHours";

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

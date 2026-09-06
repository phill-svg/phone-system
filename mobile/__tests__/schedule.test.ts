/// <reference types="jest" />
import { CLOSED_WEEK, type BusinessHours } from "../src/lib/api";
import { normalizeTime, normalizeSchedule, isSameSchedule, describeSchedule, withDay, DEFAULT_WINDOW } from "../src/lib/schedule";

describe("normalizeTime", () => {
  it("canonicalises what people actually type on a phone", () => {
    expect(normalizeTime("9")).toBe("09:00");
    expect(normalizeTime("930")).toBe("09:30");
    expect(normalizeTime("1700")).toBe("17:00");
    expect(normalizeTime("9:5")).toBe("09:05");
    expect(normalizeTime("9.30")).toBe("09:30");
    expect(normalizeTime(" 17:00 ")).toBe("17:00");
    expect(normalizeTime("00:00")).toBe("00:00");
    expect(normalizeTime("23:59")).toBe("23:59");
  });

  it("rejects anything the API would refuse, so a bad field never reaches it", () => {
    expect(normalizeTime("")).toBeNull();
    expect(normalizeTime("abc")).toBeNull();
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("12:60")).toBeNull();
    expect(normalizeTime("-1")).toBeNull();
    expect(normalizeTime("123456")).toBeNull();
  });
});

describe("normalizeSchedule", () => {
  it("always returns exactly the seven days, closed by default", () => {
    const s = normalizeSchedule({ mon: { open: "9", close: "5" } });
    expect(Object.keys(s).sort()).toEqual(["fri", "mon", "sat", "sun", "thu", "tue", "wed"]);
    expect(s.mon).toEqual({ open: "09:00", close: "05:00" });
    expect(s.tue).toBeNull();
  });

  it("drops a window whose times aren't times rather than passing it on", () => {
    expect(normalizeSchedule({ mon: { open: "nope", close: "17:00" } } as unknown as BusinessHours).mon).toBeNull();
    expect(normalizeSchedule(null)).toEqual(CLOSED_WEEK);
  });
});

describe("withDay + isSameSchedule", () => {
  it("sets one day without touching the rest, and is detected as a change", () => {
    const next = withDay(CLOSED_WEEK, "wed", DEFAULT_WINDOW);
    expect(next.wed).toEqual(DEFAULT_WINDOW);
    expect(next.mon).toBeNull();
    expect(CLOSED_WEEK.wed).toBeNull(); // original untouched
    expect(isSameSchedule(CLOSED_WEEK, next)).toBe(false);
    expect(isSameSchedule(next, withDay(CLOSED_WEEK, "wed", { ...DEFAULT_WINDOW }))).toBe(true);
  });

  it("treats a changed close time as a change", () => {
    const a = withDay(CLOSED_WEEK, "mon", { open: "09:00", close: "17:00" });
    const b = withDay(CLOSED_WEEK, "mon", { open: "09:00", close: "18:00" });
    expect(isSameSchedule(a, b)).toBe(false);
  });
});

describe("describeSchedule", () => {
  it("summarises uniform hours, varied hours and never on shift", () => {
    const uniform = { ...CLOSED_WEEK, mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" } };
    expect(describeSchedule(uniform)).toBe("Mon, Tue · 09:00–17:00");

    const varied = { ...uniform, wed: { open: "10:00", close: "14:00" } };
    expect(describeSchedule(varied)).toBe("3 days · varied hours");

    expect(describeSchedule(CLOSED_WEEK)).toBe("Never on shift");
  });
});

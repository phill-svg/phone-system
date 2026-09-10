/// <reference types="jest" />
import { CLOSED_WEEK, type BusinessHours } from "../src/lib/api";
import { normalizeTime, isCompleteTime, normalizeSchedule, isSameSchedule, describeSchedule, withDay, DEFAULT_WINDOW } from "../src/lib/schedule";

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

describe("normalizeTime: am/pm", () => {
  // Reported as "it won't let me change business hours from 10pm". A field that returns null
  // REVERTS to its previous value with no message, so typing a time in the form everyone speaks
  // looked exactly like the app refusing the change.
  it("accepts the forms a person actually types", () => {
    expect(normalizeTime("10pm")).toBe("22:00");
    expect(normalizeTime("10 pm")).toBe("22:00");
    expect(normalizeTime("10PM")).toBe("22:00");
    expect(normalizeTime("10p.m.")).toBe("22:00");
    expect(normalizeTime("6:30pm")).toBe("18:30");
    expect(normalizeTime("7am")).toBe("07:00");
    // The "m" is optional: "9:30p" is written as often as "9:30pm", and a form this refuses
    // reverts the field with no message.
    expect(normalizeTime("9:30p")).toBe("21:30");
    expect(normalizeTime("7a")).toBe("07:00");
  });

  // The two that catch people out: 12am is midnight, 12pm is noon.
  it("gets the twelves right", () => {
    expect(normalizeTime("12am")).toBe("00:00");
    expect(normalizeTime("12pm")).toBe("12:00");
    expect(normalizeTime("12:30am")).toBe("00:30");
  });

  it("refuses a meridiem on an hour that cannot have one", () => {
    expect(normalizeTime("13pm")).toBeNull();
    expect(normalizeTime("0pm")).toBeNull();
  });

  it("leaves 24-hour input alone", () => {
    expect(normalizeTime("22:00")).toBe("22:00");
    expect(normalizeTime("07:00")).toBe("07:00");
  });
});

describe("isCompleteTime", () => {
  // The editor commits on change so the Save button enables without needing a blur. It must not
  // commit a value that is still a PREFIX of what is being typed: "17:3" and "103" both parse, as
  // 17:03 and 01:03, and committing either stores hours nobody chose.
  it("refuses a value another digit could still extend", () => {
    expect(isCompleteTime("1")).toBe(false);
    expect(isCompleteTime("2")).toBe(false);
    expect(isCompleteTime("22")).toBe(false);
    // The regressions: these were called complete by the shape rule, so typing 10:30 saved 01:03.
    expect(isCompleteTime("103")).toBe(false);
    expect(isCompleteTime("123")).toBe(false);
    expect(isCompleteTime("17:3")).toBe(false);
    expect(isCompleteTime("09:3")).toBe(false);
  });

  it("treats a value no digit can extend as finished", () => {
    expect(isCompleteTime("22:00")).toBe(true);
    expect(isCompleteTime("2200")).toBe(true);
    expect(isCompleteTime("10pm")).toBe(true);
    expect(isCompleteTime("9.30")).toBe(true);
    expect(isCompleteTime("930")).toBe(true); // "9300" is not a time
    expect(isCompleteTime("17")).toBe(true); // "170".."179" are not times
  });

  it("is never true for something that is not a time at all", () => {
    expect(isCompleteTime("")).toBe(false);
    expect(isCompleteTime("later")).toBe(false);
    expect(isCompleteTime("25:00")).toBe(false);
  });
});

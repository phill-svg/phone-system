import { DAY_KEYS, CLOSED_WEEK, type BusinessHours, type DayKey, type DayWindow } from "./api";

// A day the app opens when you tick it on -- ordinary trading hours, so the common case is one tap.
export const DEFAULT_WINDOW: NonNullable<DayWindow> = { open: "09:00", close: "17:00" };

// Accepts what someone actually types on a phone keypad -- "9", "930", "9:5", "9.30", "1700",
// "10pm" -- and returns canonical 24-hour "HH:MM", or null if it isn't a time. The API validates
// every field against /^([01]\d|2[0-3]):([0-5]\d)$/ AND requires close > open (isDayWindow in
// src/ivr/businessHours.ts, where a close of "00:00" means end-of-day), and it rejects the WHOLE
// schedule -- all seven days -- if one field is wrong. So a half-typed field must never reach it.
//
// **am/pm is accepted**, and that is not a nicety: the field reverts to its previous value when
// this returns null, silently, so typing "10pm" LOOKED like the app refusing to change the hours.
// The screen's footer said only "24-hour", which nobody reads while typing a time they already
// know; it now says both, but the parser is what actually has to be forgiving.
export function normalizeTime(raw: string): string | null {
  let s = raw.trim().toLowerCase();

  // Pull the meridiem off first so the numeric parsing below is unchanged by it. "10 p.m.",
  // "10pm" and "10:30 PM" all reduce to the digits plus a flag. The trailing "m" is OPTIONAL
  // because "9:30p" is written as often as "9:30pm", and every form this refuses reverts the
  // field silently -- which is the failure this whole function exists to stop.
  let meridiem: "am" | "pm" | null = null;
  const withMeridiem = /^(.*?)\s*([ap])\.?\s*(?:m\.?)?$/.exec(s);
  if (withMeridiem) {
    s = withMeridiem[1];
    meridiem = withMeridiem[2] === "p" ? "pm" : "am";
  }

  s = s.replace(/[.\s]/g, ":");
  let hours: number;
  let minutes: number;
  const withSeparator = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (withSeparator) {
    hours = Number(withSeparator[1]);
    minutes = Number(withSeparator[2]);
  } else if (/^\d{1,2}$/.test(s)) {
    hours = Number(s);
    minutes = 0;
  } else if (/^\d{3,4}$/.test(s)) {
    hours = Number(s.slice(0, s.length - 2));
    minutes = Number(s.slice(-2));
  } else {
    return null;
  }
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;

  if (meridiem) {
    // 12-hour input, so only 1-12 is meaningful. "13pm" is a typo, not 1pm.
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  }

  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// Is this text a COMPLETE time, as opposed to something still being typed?
//
// The editor commits on change as well as on blur (see ScheduleEditor), and it must not commit a
// half-typed value: "103" parses perfectly well as 01:03, but it is what "1030" looks like one
// keystroke from the end, so committing it stores an opening time nobody chose.
//
// The rule is PREFIX-FREEDOM, not a list of shapes: finished means no digit could be appended to
// make another valid time. "930" is finished, because "9300" is not a time; "103" and "17:3" are
// not, because "1030" and "17:30" are. A shape list was tried first and is what produced the bug
// -- it called every 3-digit string and every "H:M" complete, so typing "17:30" committed 17:03.
//
// Only DIGITS are considered. A separator or a meridiem is a keystroke the user can always still
// add, so counting those would make "17" unfinished forever and put us back to committing nothing
// until blur -- which is the bug this whole path exists to fix.
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function isCompleteTime(raw: string): boolean {
  const s = raw.trim();
  if (normalizeTime(s) === null) return false;
  return DIGITS.every((digit) => normalizeTime(s + digit) === null);
}

// Immutably set one day's window (null = closed).
export function withDay(schedule: BusinessHours, day: DayKey, window: DayWindow): BusinessHours {
  return { ...schedule, [day]: window };
}

// The API replaces the whole schedule on every PUT, so a partial object -- or one carrying an
// extra key -- is rejected as invalid. This is what guarantees exactly the seven expected days.
export function normalizeSchedule(input: Partial<BusinessHours> | null | undefined): BusinessHours {
  const out = { ...CLOSED_WEEK };
  for (const day of DAY_KEYS) {
    const w = input?.[day];
    if (w && typeof w.open === "string" && typeof w.close === "string") {
      const open = normalizeTime(w.open);
      const close = normalizeTime(w.close);
      if (open && close) out[day] = { open, close };
    }
  }
  return out;
}

export function isSameSchedule(a: BusinessHours, b: BusinessHours): boolean {
  return DAY_KEYS.every((day) => {
    const x = a[day];
    const y = b[day];
    if (x === null || y === null) return x === y;
    return x.open === y.open && x.close === y.close;
  });
}

// "Mon–Fri 09:00–17:00" style summary for a list row. Closed every day reads as "Never on shift",
// which is the honest reading: that person is never in the ring cascade.
export function describeSchedule(schedule: BusinessHours): string {
  const open = DAY_KEYS.filter((d) => schedule[d] !== null);
  if (open.length === 0) return "Never on shift";
  const first = schedule[open[0]]!;
  const uniform = open.every((d) => schedule[d]!.open === first.open && schedule[d]!.close === first.close);
  const days = open.map((d) => d[0].toUpperCase() + d.slice(1, 3)).join(", ");
  return uniform ? `${days} · ${first.open}–${first.close}` : `${open.length} days · varied hours`;
}

export type DayWindow = { open: string; close: string } | null;

export type BusinessHoursSchedule = {
  mon: DayWindow;
  tue: DayWindow;
  wed: DayWindow;
  thu: DayWindow;
  fri: DayWindow;
  sat: DayWindow;
  sun: DayWindow;
};

const DAY_KEYS: (keyof BusinessHoursSchedule)[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME_ZONE = "Australia/Sydney";

// Validation lives HERE, with the type, because it was previously duplicated in api/settings.ts and
// api/staff.ts and both copies checked only the `\d{2}:\d{2}` SHAPE. Nothing verified that the day
// was actually open at any point:
//
//   isWithinBusinessHours is `minutes >= open && minutes < close`
//
// so a window saved as 09:00-00:00 -- the natural way to write "until midnight" -- or an inverted
// one, or "99:99" (which the shape check happily admits), reads as CLOSED ALL DAY. Every in-hours
// call routed to after-hours and that person dropped off the ring roster, while the schedule screen
// showed hours that look perfectly correct. A window nobody can be reached in is a typo, not a
// preference, so it is refused at the point of write.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A close of "00:00" means MIDNIGHT, i.e. the end of this day -- not minute zero of it.
//
// It has to mean that in both directions or the fix is worse than the bug: rejecting it outright
// would make "open until midnight" inexpressible, and it is the natural way to write a late
// closing time. Reading it as 0 is what made such a day silently closed, since
// `minutes >= open && minutes < 0` is never true.
export const END_OF_DAY_MINUTES = 24 * 60;

function closeMinutes(close: string): number {
  return close === "00:00" ? END_OF_DAY_MINUTES : toMinutes(close);
}

export function isDayWindow(value: unknown): value is DayWindow {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  if (typeof w.open !== "string" || !TIME_RE.test(w.open)) return false;
  if (typeof w.close !== "string" || !TIME_RE.test(w.close)) return false;
  return closeMinutes(w.close) > toMinutes(w.open);
}

export function isBusinessHoursSchedule(value: unknown): value is BusinessHoursSchedule {
  if (typeof value !== "object" || value === null) return false;
  const schedule = value as Record<string, unknown>;
  if (Object.keys(schedule).length !== DAY_KEYS.length) return false;
  return DAY_KEYS.every((day) => Object.prototype.hasOwnProperty.call(schedule, day) && isDayWindow(schedule[day]));
}

function localParts(at: Date): { dayKey: keyof BusinessHoursSchedule; minutesSinceMidnight: number } {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(at);
  const weekdayShort = parts.find((p) => p.type === "weekday")!.value.toLowerCase();
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  const dayKey = DAY_KEYS.find((k) => weekdayShort.startsWith(k))!;
  return { dayKey, minutesSinceMidnight: hour * 60 + minute };
}

// The Canberra calendar date (YYYY-MM-DD) at a given instant. Availability overrides are scoped
// to a local day, so "is this override still today's?" must be asked in the business's timezone,
// not the Worker's UTC.
export function localDateKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinBusinessHours(schedule: BusinessHoursSchedule, at: Date): boolean {
  const { dayKey, minutesSinceMidnight } = localParts(at);
  const window = schedule[dayKey];
  if (!window) return false;
  const open = toMinutes(window.open);
  const close = closeMinutes(window.close);
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}

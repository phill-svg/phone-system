import { DAY_KEYS, CLOSED_WEEK, type BusinessHours, type DayKey, type DayWindow } from "./api";

// A day the app opens when you tick it on -- ordinary trading hours, so the common case is one tap.
export const DEFAULT_WINDOW: NonNullable<DayWindow> = { open: "09:00", close: "17:00" };

// Accepts what someone actually types on a phone keypad -- "9", "930", "9:5", "9.30", "1700" --
// and returns canonical "HH:MM", or null if it isn't a time. The API validates every field against
// /^\d{2}:\d{2}$/ and rejects the WHOLE schedule if one is malformed, so a half-typed field must
// never reach it.
export function normalizeTime(raw: string): string | null {
  const s = raw.trim().replace(/[.\s]/g, ":");
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
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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

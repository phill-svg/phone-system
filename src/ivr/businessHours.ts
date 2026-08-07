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

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinBusinessHours(schedule: BusinessHoursSchedule, at: Date): boolean {
  const { dayKey, minutesSinceMidnight } = localParts(at);
  const window = schedule[dayKey];
  if (!window) return false;
  const open = toMinutes(window.open);
  const close = toMinutes(window.close);
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}

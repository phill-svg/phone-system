// Date-rule evaluation for the IVR "Date rule" node: decides whether the current calendar date
// (in Australia/Sydney, matching businessHours.ts) counts as a "closed" date. Complements the
// time-of-day "business_hours" check.
//
// A closed-dates list entry may be:
//   - "YYYY-MM-DD"                exact date            e.g. "2026-12-25"
//   - "YYYY-MM-DD..YYYY-MM-DD"    inclusive date range  e.g. "2026-12-24..2027-01-02"
//   - "MM-DD"                     recurring every year  e.g. "12-25" (every 25 Dec)
const TIME_ZONE = "Australia/Sydney";

function sydneyDateParts(at: Date): { ymd: string; md: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return { ymd: `${year}-${month}-${day}`, md: `${month}-${day}` };
}

export function isClosedDate(closedDates: unknown, at: Date): boolean {
  if (!Array.isArray(closedDates) || closedDates.length === 0) return false;
  const { ymd, md } = sydneyDateParts(at);
  for (const raw of closedDates) {
    const entry = String(raw).trim();
    if (!entry) continue;
    if (entry.includes("..")) {
      const [start, end] = entry.split("..").map((s) => s.trim());
      if (start && end && ymd >= start && ymd <= end) return true;
    } else if (/^\d{2}-\d{2}$/.test(entry)) {
      if (md === entry) return true;
    } else if (ymd === entry) {
      return true;
    }
  }
  return false;
}

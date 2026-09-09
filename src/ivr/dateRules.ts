// Date-rule evaluation for the IVR "Date rule" node: decides whether the current calendar date
// (in Australia/Sydney, matching businessHours.ts) counts as a "closed" date. Complements the
// time-of-day "business_hours" check.
//
// A closed-dates list entry may be:
//   - "YYYY-MM-DD"                exact date             e.g. "2026-12-25"
//   - "YYYY-MM-DD..YYYY-MM-DD"    inclusive date range   e.g. "2026-12-24..2027-01-02"
//   - "MM-DD"                     recurring every year   e.g. "12-25" (every 25 Dec)
//   - "MM-DD..MM-DD"              recurring RANGE        e.g. "12-24..01-02" (every year)
//
// The recurring range is compared against MM-DD, not YYYY-MM-DD -- against the latter it could
// never match, because "2026-12-27" <= "12-31" is already false on the first character. One that
// wraps the new year ("12-24..01-02") is two ranges under string comparison, and is handled as such.
// Entries are validated on write by isValidClosedDateEntry, because an entry this cannot read is
// SKIPPED here -- refusing to answer calls over a typo would be worse -- and would otherwise leave
// the IVR open on the one day of the year it mattered.
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

const MD_RE = /^\d{2}-\d{2}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Whether an entry is one this matcher can actually act on.
//
// Unrecognised entries are SKIPPED, silently, which means a mistyped holiday leaves the IVR open on
// the one day of the year it mattered and nothing anywhere says so. The matcher keeps skipping --
// refusing to answer calls over a typo would be worse -- but the write path validates with this, so
// the typo is refused where someone is looking at it.
// The digit SHAPE is not enough. "25-12" (a day-first typo of Christmas) and "2026-13-01" both
// match their regex, save cleanly, and can never match a real date -- which is the same silent
// no-op as an unparseable entry, reached by a different door.
function isRealMonthDay(md: string): boolean {
  const [m, d] = md.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= DAYS_IN_MONTH[m - 1];
}

// Leap-year-generous on purpose: 02-29 is a real date, and a recurring entry has no year to check
// it against.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidMd(entry: string): boolean {
  return MD_RE.test(entry) && isRealMonthDay(entry);
}

function isValidYmd(entry: string): boolean {
  return YMD_RE.test(entry) && isRealMonthDay(entry.slice(5));
}

export function isValidClosedDateEntry(raw: unknown): boolean {
  const entry = String(raw ?? "").trim();
  if (!entry) return false;
  if (entry.includes("..")) {
    const [start, end] = entry.split("..").map((s) => s.trim());
    if (!start || !end) return false;
    // Both ends must be the same KIND, or the comparison is meaningless in either direction.
    if (isValidMd(start) && isValidMd(end)) return true;
    // A full-date range must also run forwards -- an inverted one matches nothing, silently.
    return isValidYmd(start) && isValidYmd(end) && start <= end;
  }
  return isValidMd(entry) || isValidYmd(entry);
}

export function isClosedDate(closedDates: unknown, at: Date): boolean {
  if (!Array.isArray(closedDates) || closedDates.length === 0) return false;
  const { ymd, md } = sydneyDateParts(at);
  for (const raw of closedDates) {
    const entry = String(raw).trim();
    if (!entry) continue;
    if (entry.includes("..")) {
      const [start, end] = entry.split("..").map((s) => s.trim());
      if (!start || !end) continue;
      // Compare like with like. Both ends bare MM-DD is a RECURRING range (the obvious extension of
      // the bare MM-DD form above), and it has to be matched against `md` -- against `ymd` it can
      // never fire, because "2026-12-27" <= "12-31" is already false on the first character. So a
      // Christmas shutdown written the natural way left the IVR open every day of it.
      const recurring = MD_RE.test(start) && MD_RE.test(end);
      const value = recurring ? md : ymd;
      // A recurring range that wraps the new year (12-24..01-02) is two ranges, not one.
      if (recurring && end < start) {
        if (value >= start || value <= end) return true;
      } else if (value >= start && value <= end) {
        return true;
      }
    } else if (MD_RE.test(entry)) {
      if (md === entry) return true;
    } else if (ymd === entry) {
      return true;
    }
  }
  return false;
}

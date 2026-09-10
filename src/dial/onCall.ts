// Who covers calls outside business hours.
//
// The daytime roster answers "who is on shift right now", and after hours that set is empty by
// construction -- every staff schedule has closed. That is why the closed branch of the IVR could
// only ever reach voicemail. On-call is the deliberate exception: exactly ONE person, chosen by a
// weekly rotation, who is reachable when nobody is on shift.
//
// Weeks run Monday to Monday in Australia/Sydney. The timezone is duplicated from businessHours.ts
// rather than imported from src/html/ for the reason recorded there: which week it is here is a
// ROUTING decision, not a label on a screen, and routing must not depend on the presentation layer.
const TIME_ZONE = "Australia/Sydney";

const DAY_INDEX: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

export type OnCallRotation = {
  // Ordered staff emails. Position IS the rotation order; the list rotates one step per week.
  members: string[];
  // The Monday (Sydney YYYY-MM-DD) that members[0] covered. Every later week is counted from here.
  anchorWeekStart: string;
};

const WEEK_START_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isOnCallRotation(value: unknown): value is OnCallRotation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.members) || !v.members.every((m) => typeof m === "string" && m.trim() !== "")) return false;
  // An empty rotation is legal and means "nobody is on call" -- the state the business is in before
  // anyone is assigned. It needs no anchor, and demanding one would make the empty list unsaveable.
  if (v.members.length === 0) return v.anchorWeekStart === "" || typeof v.anchorWeekStart === "string";
  return typeof v.anchorWeekStart === "string" && isWeekStartKey(v.anchorWeekStart);
}

export function isWeekStartKey(key: string): boolean {
  if (!WEEK_START_RE.test(key)) return false;
  const at = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(at)) return false;
  // A date key that is not a Monday would silently shift every rotation boundary by a few days, so
  // it is refused where it is written rather than quietly normalised.
  return new Date(at).getUTCDay() === 1;
}

// The Monday of the week `at` falls in, as a Sydney YYYY-MM-DD key.
//
// The calendar date is resolved in Sydney FIRST and only then shifted backwards, so a call at 9am
// Monday Canberra is never counted into the previous week because UTC still says Sunday. The
// arithmetic afterwards runs in UTC on a bare calendar date, where a day is exactly 24 hours and
// no daylight-saving transition can move a boundary.
export function weekStartKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const weekdayShort = get("weekday").toLowerCase().slice(0, 3);
  const offset = DAY_INDEX[weekdayShort];
  // `?? 0` here would treat any unrecognised weekday token as Monday, so every call would resolve
  // its own calendar date as a "week start". That is not a Monday, so weeksBetween returns a
  // fractional count, Math.round snaps it arbitrarily, and the rota names a semi-random person --
  // while isWeekStartKey still passes, because it only ever validates the ANCHOR. Silent, and
  // exactly the failure class the rest of this module exists to remove. Throw instead: every
  // caller already treats a failure as "nobody on call", which falls through to voicemail.
  if (offset === undefined) throw new Error(`weekStartKey: unrecognised weekday '${weekdayShort}'`);
  const midnight = Date.parse(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  return new Date(midnight - offset * 86_400_000).toISOString().slice(0, 10);
}

export function weeksBetween(fromWeekStart: string, toWeekStart: string): number {
  const from = Date.parse(`${fromWeekStart}T00:00:00Z`);
  const to = Date.parse(`${toWeekStart}T00:00:00Z`);
  return Math.round((to - from) / (7 * 86_400_000));
}

// Whose turn it is in the given week, ignoring overrides and ignoring whether that person still
// works here. Pure, so the Admin screen can show the upcoming weeks without hitting the database.
//
// Weeks BEFORE the anchor are handled by a floored modulo rather than allowed to produce a negative
// index: setting an anchor of next Monday would otherwise make this week resolve to `undefined` and
// silently leave tonight uncovered.
export function rotationMemberFor(rotation: OnCallRotation, weekStart: string): string | null {
  if (rotation.members.length === 0 || !isWeekStartKey(rotation.anchorWeekStart)) return null;
  const elapsed = weeksBetween(rotation.anchorWeekStart, weekStart);
  const size = rotation.members.length;
  const index = ((elapsed % size) + size) % size;
  return rotation.members[index] ?? null;
}

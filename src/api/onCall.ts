import { getStaffRoster } from "../db/staff";
import type { StaffPresenceRow } from "../dial/presence";
import {
  clearOnCallOverride,
  getOnCallRotation,
  listOnCallOverrides,
  setOnCallOverride,
  setOnCallRotation,
} from "../db/onCall";
import { isWeekStartKey, rotationMemberFor, weekStartKey, type OnCallRotation } from "../dial/onCall";
import type { StaffUser } from "../access/requireStaffUser";

const PREVIEW_WEEKS = 8;

// The roster these endpoints may offer and accept.
//
// `resolveRingTargets` drops the demo account before anything else is considered, so a rotation
// naming it resolves to nobody and every after-hours caller hears voicemail -- while Health Checks
// reports "ok, reviewer is on call, ringing +61...", because it read the same unfiltered list. The
// exclusion has to happen where the name is CHOSEN, not only where it is dialled. `/api/staff` is
// already passed demoEmails(env) for exactly this reason.
async function selectableRoster(db: D1Database, exclude: string[]): Promise<StaffPresenceRow[]> {
  const excluded = new Set(exclude.map((e) => e.trim().toLowerCase()));
  const roster = await getStaffRoster(db);
  return roster.filter((s) => !excluded.has(s.email.toLowerCase()));
}

// Stored addresses are compared against `staff_users`, which only ever holds lowercase (invites
// lowercase on write). Storing "Tech@X.com" passes the case-insensitive validation below and then
// fails every strict comparison the two admin UIs make -- the person shows up as both rostered and
// not-rostered at once, and the duplicate cannot be removed. Normalise once, here.
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

export type OnCallWeek = {
  weekStart: string;
  email: string | null;
  source: "rotation" | "override" | "nobody";
};

// The next few weeks, resolved exactly the way a real call resolves them. The preview is not a
// convenience: a rotation is a rule about the future, and the only way to be sure the rule says
// what you meant is to see the weeks it produces before a customer does.
export function previewWeeks(
  rotation: OnCallRotation,
  overrides: Map<string, string>,
  fromWeekStart: string,
  count: number
): OnCallWeek[] {
  const start = Date.parse(`${fromWeekStart}T00:00:00Z`);
  const weeks: OnCallWeek[] = [];
  for (let i = 0; i < count; i++) {
    const weekStart = new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10);
    const override = overrides.get(weekStart);
    if (override) {
      weeks.push({ weekStart, email: override, source: "override" });
      continue;
    }
    const member = rotationMemberFor(rotation, weekStart);
    weeks.push({ weekStart, email: member, source: member ? "rotation" : "nobody" });
  }
  return weeks;
}

export async function handleGetOnCall(db: D1Database, excludeEmails: string[] = []): Promise<Response> {
  const thisWeek = weekStartKey(new Date());
  const [rotation, overrideRows, roster] = await Promise.all([
    getOnCallRotation(db),
    listOnCallOverrides(db, thisWeek),
    selectableRoster(db, excludeEmails),
  ]);
  const overrides = new Map(overrideRows.map((r) => [r.week_start, r.staff_email]));
  const weeks = previewWeeks(rotation, overrides, thisWeek, PREVIEW_WEEKS);
  const known = new Set(roster.map((s) => s.email.toLowerCase()));
  return jsonResponse({
    rotation,
    thisWeek,
    weeks,
    // Names in the rotation that are no longer staff. Reported rather than silently dropped: the
    // rotation still advances past them, so a departed tech leaves one week a month uncovered and
    // nothing else would ever say so.
    unknownMembers: rotation.members.filter((m) => !known.has(m.toLowerCase())),
    staff: roster.map((s) => s.email),
  });
}

export async function handlePutOnCall(
  request: Request,
  db: D1Database,
  staff: StaffUser,
  excludeEmails: string[] = []
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid request body");
  }
  if (typeof body !== "object" || body === null) return badRequest("invalid request body");
  const { members, anchorWeekStart } = body as { members?: unknown; anchorWeekStart?: unknown };
  if (!Array.isArray(members) || !members.every((m) => typeof m === "string")) {
    return badRequest("members must be a list of staff emails");
  }
  const cleaned = members.map(normalizeEmail).filter((m) => m !== "");

  // A duplicate does not fail loudly at ring time -- it just gives that person two weeks in the
  // cycle, which reads as a mysteriously unfair rota months later.
  const seen = new Set<string>();
  for (const m of cleaned) {
    if (seen.has(m)) return badRequest(`${m} is in the rotation twice`);
    seen.add(m);
  }

  // Validated against the real roster because the failure mode of a typo is silence: the week comes
  // round, nobody is found, and the caller hears voicemail exactly as though no rota existed.
  const roster = await selectableRoster(db, excludeEmails);
  const known = new Set(roster.map((s) => s.email.toLowerCase()));
  const unknown = cleaned.filter((m) => !known.has(m));
  if (unknown.length > 0) return badRequest(`not staff members: ${unknown.join(", ")}`);

  let anchor = typeof anchorWeekStart === "string" && anchorWeekStart !== "" ? anchorWeekStart : weekStartKey(new Date());
  if (cleaned.length === 0) anchor = "";
  else if (!isWeekStartKey(anchor)) return badRequest("anchorWeekStart must be a Monday, as YYYY-MM-DD");

  const rotation: OnCallRotation = { members: cleaned, anchorWeekStart: anchor };
  await setOnCallRotation(db, rotation);
  console.log("ON_CALL_ROTATION_SET", JSON.stringify({ by: staff.email, members: cleaned.length, anchor }));
  return jsonResponse({ ok: true, rotation });
}

export async function handlePutOnCallOverride(
  request: Request,
  db: D1Database,
  staff: StaffUser,
  excludeEmails: string[] = []
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid request body");
  }
  if (typeof body !== "object" || body === null) return badRequest("invalid request body");
  const { weekStart, email } = body as { weekStart?: unknown; email?: unknown };
  if (typeof weekStart !== "string" || !isWeekStartKey(weekStart)) {
    return badRequest("weekStart must be a Monday, as YYYY-MM-DD");
  }
  if (email === null || email === "") {
    await clearOnCallOverride(db, weekStart);
    console.log("ON_CALL_OVERRIDE_CLEARED", JSON.stringify({ by: staff.email, weekStart }));
    return jsonResponse({ ok: true });
  }
  if (typeof email !== "string") return badRequest("email must be a staff email, or null to clear");
  const wanted = normalizeEmail(email);
  const roster = await selectableRoster(db, excludeEmails);
  if (!roster.some((s) => s.email.toLowerCase() === wanted)) {
    return badRequest(`not a staff member: ${email}`);
  }
  await setOnCallOverride(db, weekStart, wanted, staff.email);
  console.log("ON_CALL_OVERRIDE_SET", JSON.stringify({ by: staff.email, weekStart, email: wanted }));
  return jsonResponse({ ok: true });
}

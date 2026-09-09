import { isBusinessHoursSchedule } from "../ivr/businessHours";
import type { BusinessHoursSchedule } from "../ivr/businessHours";
import type { StaffPresenceRow, StaffStatus } from "../dial/presence";

type StaffRow = {
  email: string;
  role: "admin" | "staff";
  status: StaffStatus;
  away_reason: string | null;
  schedule: string;
  last_heartbeat_at: number | null;
  ring_priority: number | null;
};

// Nobody's schedule is worth every caller. getStaffRoster feeds resolveRingTargets, which runs
// inside startRing -- so a JSON.parse throw here does not just lose one person's hours, it escapes
// to the DO's catch-all and HANGS UP on a live customer (the tier 1 lesson, third instance). One
// unreadable row therefore costs that one person their legs for this call, loudly, and everyone
// else still rings: an empty schedule is off-shift everywhere, which is the conservative answer.
const NO_SCHEDULE: BusinessHoursSchedule = {
  mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
};

function parseSchedule(email: string, raw: string): BusinessHoursSchedule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.log(
      "STAFF_SCHEDULE_UNPARSEABLE",
      JSON.stringify({ email, error: err instanceof Error ? err.message : String(err) })
    );
    return NO_SCHEDULE;
  }
  // Catching the THROW is not enough: a column holding the literal text `null` parses perfectly
  // well, and isWithinBusinessHours then does `schedule[dayKey]` on it and throws a TypeError --
  // straight back into the hangup path this function exists to close. The shape has to be checked,
  // not just the syntax.
  if (!isBusinessHoursSchedule(parsed)) {
    console.log("STAFF_SCHEDULE_UNPARSEABLE", JSON.stringify({ email, error: "not a schedule shape" }));
    return NO_SCHEDULE;
  }
  return parsed;
}

function toPresenceRow(row: StaffRow): StaffPresenceRow {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    awayReason: row.away_reason,
    schedule: parseSchedule(row.email, row.schedule),
    lastHeartbeatAt: row.last_heartbeat_at,
    ringPriority: row.ring_priority ?? 100,
  };
}

export async function getStaffRoster(db: D1Database): Promise<StaffPresenceRow[]> {
  const result = await db.prepare("SELECT * FROM staff_users").all<StaffRow>();
  return result.results.map(toPresenceRow);
}

export async function getStaffByEmail(db: D1Database, email: string): Promise<StaffPresenceRow | null> {
  const row = await db.prepare("SELECT * FROM staff_users WHERE email = ?").bind(email).first<StaffRow>();
  return row ? toPresenceRow(row) : null;
}

// `setOn` is the Canberra calendar date the person made this choice, so resetAvailabilityForNewDay
// can tell today's override from a forgotten one. Setting yourself back to available clears it --
// there is nothing to expire.
export async function setStaffStatus(
  db: D1Database,
  email: string,
  status: StaffStatus,
  awayReason: string | null | undefined,
  setOn: string | null = null
): Promise<void> {
  // `undefined` means "say nothing about the reason", which is not the same as `null` ("clear it").
  // Only going/staying AWAY can preserve one -- a reason belongs to being away, so any other status
  // clears it whether the caller mentioned it or not, and an available person can never be left
  // carrying a stale "On site until 3".
  const preserve = awayReason === undefined && status === "away";
  const stamp = status === "available" ? null : setOn;
  await db
    .prepare(
      preserve
        ? "UPDATE staff_users SET status = ?, status_set_on = ? WHERE email = ?"
        : "UPDATE staff_users SET status = ?, status_set_on = ?, away_reason = ? WHERE email = ?"
    )
    .bind(...(preserve ? [status, stamp, email] : [status, stamp, awayReason ?? null, email]))
    .run();
}

// Availability is a one-day override. Anyone still marked away/offline from an earlier day -- or
// who never set it themselves at all -- goes back to available, so a single sick day cannot drop
// someone off the ring roster indefinitely. Runs on the 5-minute cron, so the reset lands within
// minutes of local midnight.
export async function resetAvailabilityForNewDay(db: D1Database, today: string): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE staff_users SET status = 'available', away_reason = NULL, status_set_on = NULL " +
        "WHERE status <> 'available' AND (status_set_on IS NULL OR status_set_on <> ?)"
    )
    .bind(today)
    .run();
  return result.meta.changes ?? 0;
}

// Sets a staff member's cascade ring priority (lower rings earlier).
export async function setStaffPriority(db: D1Database, email: string, priority: number): Promise<void> {
  await db.prepare("UPDATE staff_users SET ring_priority = ? WHERE email = ?").bind(Math.round(priority), email).run();
}

export async function setStaffSchedule(db: D1Database, email: string, schedule: BusinessHoursSchedule): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET schedule = ? WHERE email = ?")
    .bind(JSON.stringify(schedule), email)
    .run();
}

export async function touchHeartbeat(db: D1Database, email: string): Promise<void> {
  await db.prepare("UPDATE staff_users SET last_heartbeat_at = ? WHERE email = ?").bind(Date.now(), email).run();
}

export async function createInvitedStaff(db: D1Database, email: string, role: "admin" | "staff"): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, ?, ?)")
    .bind(email, role, Date.now())
    .run();
}

export async function deleteStaff(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM staff_users WHERE email = ?").bind(email).run();
}

export async function listStaffAccess(
  db: D1Database
): Promise<{ email: string; role: "admin" | "staff"; hasPassword: boolean }[]> {
  const rows = await db
    .prepare("SELECT email, role, password_hash FROM staff_users ORDER BY email")
    .all<{ email: string; role: "admin" | "staff"; password_hash: string | null }>();
  return rows.results.map((r) => ({ email: r.email, role: r.role, hasPassword: r.password_hash !== null }));
}

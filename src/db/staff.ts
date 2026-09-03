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

function toPresenceRow(row: StaffRow): StaffPresenceRow {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    awayReason: row.away_reason,
    schedule: JSON.parse(row.schedule) as BusinessHoursSchedule,
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
  awayReason: string | null,
  setOn: string | null = null
): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET status = ?, away_reason = ?, status_set_on = ? WHERE email = ?")
    .bind(status, awayReason, status === "available" ? null : setOn, email)
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

import type { BusinessHoursSchedule } from "../ivr/businessHours";
import type { StaffPresenceRow, StaffStatus } from "../dial/presence";

type StaffRow = {
  email: string;
  role: "admin" | "staff";
  status: StaffStatus;
  away_reason: string | null;
  schedule: string;
  last_heartbeat_at: number | null;
  mobile_number: string | null;
};

function toPresenceRow(row: StaffRow): StaffPresenceRow {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    awayReason: row.away_reason,
    schedule: JSON.parse(row.schedule) as BusinessHoursSchedule,
    lastHeartbeatAt: row.last_heartbeat_at,
    mobileNumber: row.mobile_number ?? null,
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

export async function setStaffStatus(
  db: D1Database,
  email: string,
  status: StaffStatus,
  awayReason: string | null
): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET status = ?, away_reason = ? WHERE email = ?")
    .bind(status, awayReason, email)
    .run();
}

// Sets (or clears, when null) a staff member's PSTN failover mobile number. Stored as entered;
// the ring plan normalizes it to a diallable E.164 form at dial time.
export async function setStaffMobile(db: D1Database, email: string, mobileNumber: string | null): Promise<void> {
  const value = mobileNumber && mobileNumber.trim() ? mobileNumber.trim() : null;
  await db.prepare("UPDATE staff_users SET mobile_number = ? WHERE email = ?").bind(value, email).run();
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

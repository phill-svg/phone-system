import { jsonResponse } from "./respond";
import type { StaffUser } from "../access/requireStaffUser";

// Includes the caller's own availability, which the app shows and lets them change. Read from the
// row rather than the session so it reflects a change made anywhere (admin page, another device).
export async function handleMe(db: D1Database, staff: StaffUser): Promise<Response> {
  const row = await db
    .prepare("SELECT status, away_reason FROM staff_users WHERE email = ?")
    .bind(staff.email)
    .first<{ status: string; away_reason: string | null }>();
  return jsonResponse({
    ...staff,
    status: row?.status ?? "offline",
    awayReason: row?.away_reason ?? null,
  });
}

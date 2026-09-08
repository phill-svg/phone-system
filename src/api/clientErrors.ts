import { jsonResponse } from "./respond";
import {
  MAX_REPORTS_PER_BATCH,
  parseClientErrorReport,
  recordClientErrors,
  listClientErrors,
} from "../db/clientErrors";
import type { StaffUser } from "../access/requireStaffUser";

// Crash reports from the mobile app.
//
// Reporting is open to any signed-in staff member -- the whole point is to hear from a handset that
// is falling over, and gating it on a role would silently lose exactly the reports we most need.
// READING them is admin-only, because a stack trace is internals.
export async function handleReportClientErrors(db: D1Database, request: Request, staff: StaffUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "expected JSON" }, 400);
  }
  const raw = Array.isArray(body) ? body : [body];
  // Over-long batches are truncated rather than rejected: a device with 50 queued crashes is the
  // one we want to hear from, and a 400 would make it retry the same oversized batch forever.
  const reports = raw
    .slice(0, MAX_REPORTS_PER_BATCH)
    .map(parseClientErrorReport)
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const stored = await recordClientErrors(db, staff.email, reports);
  for (const r of reports) {
    console.log(
      "CLIENT_ERROR",
      JSON.stringify({
        by: staff.email,
        platform: r.platform,
        ota: r.otaBuild,
        fatal: r.fatal,
        screen: r.screen,
        message: r.message.slice(0, 200),
      })
    );
  }
  return jsonResponse({ stored });
}

export async function handleListClientErrors(db: D1Database): Promise<Response> {
  return jsonResponse({ errors: await listClientErrors(db) });
}

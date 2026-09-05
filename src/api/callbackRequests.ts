import { jsonResponse } from "./respond";
import { listCallbackRequests, setCallbackRequestStatus } from "../db/callbackRequests";
import type { StaffUser } from "../access/requireStaffUser";

// Open requests plus a bounded tail of handled ones -- the app shows the open list as a work queue
// and the rest as history, so "did anyone ring this person back?" stays answerable.
export async function handleListCallbackRequests(db: D1Database): Promise<Response> {
  return jsonResponse(await listCallbackRequests(db));
}

export async function handleUpdateCallbackRequest(
  request: Request,
  db: D1Database,
  id: number,
  staff: StaffUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  if (!body) return jsonResponse({ error: "invalid request body" }, 400);
  const status = body.status;
  if (status !== "open" && status !== "done") {
    return jsonResponse({ error: "status must be 'open' or 'done'" }, 400);
  }
  const ok = await setCallbackRequestStatus(db, id, status, staff.email);
  return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: "not found" }, 404);
}

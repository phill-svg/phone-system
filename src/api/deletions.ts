import { jsonResponse } from "./respond";
import { softDeleteCall, restoreCall } from "../db/calls";
import { softDeleteThread, restoreThread } from "../db/messages";
import type { StaffUser } from "../access/requireStaffUser";

// Admin-only removal of call logs and conversations.
//
// Both are HIDES, not deletes -- see migration 0032. The row survives, the Twilio recording is left
// alone, and every one of these returns what an undo would need, because a mis-tap on a shared
// business record has to be reversible by the person who made it, not by someone with D1 access.

function forbidden(staff: StaffUser): Response | null {
  // Business-wide records: one person deleting removes it for the whole team.
  return staff.role === "admin" ? null : new Response("forbidden", { status: 403 });
}

export async function handleDeleteCall(db: D1Database, callId: string, staff: StaffUser): Promise<Response> {
  const denied = forbidden(staff);
  if (denied) return denied;
  const ok = await softDeleteCall(db, callId, staff.email);
  // Already hidden, or never existed. Either way there is nothing to undo, and saying so beats a
  // silent 200 that leaves the app offering an Undo that would do nothing.
  if (!ok) return jsonResponse({ error: "That call is already deleted, or doesn't exist." }, 404);
  console.log("CALL_DELETED", JSON.stringify({ callId, by: staff.email }));
  return jsonResponse({ ok: true });
}

export async function handleRestoreCall(db: D1Database, callId: string, staff: StaffUser): Promise<Response> {
  const denied = forbidden(staff);
  if (denied) return denied;
  const ok = await restoreCall(db, callId);
  if (!ok) return jsonResponse({ error: "That call isn't deleted." }, 404);
  console.log("CALL_RESTORED", JSON.stringify({ callId, by: staff.email }));
  return jsonResponse({ ok: true });
}

export async function handleDeleteThread(db: D1Database, peerNumber: string, staff: StaffUser): Promise<Response> {
  const denied = forbidden(staff);
  if (denied) return denied;
  // Stamped once for the whole thread so the undo can target exactly the messages this delete hid,
  // and not also revive an older deletion of the same conversation. The SAME value is both written
  // and returned -- softDeleteThread used to take its own Date.now(), which is a different reading
  // across the await and broke Undo whenever the two landed in different milliseconds.
  const deletedAt = Date.now();
  const hidden = await softDeleteThread(db, peerNumber, staff.email, deletedAt);
  if (hidden === 0) return jsonResponse({ error: "That conversation is already deleted, or doesn't exist." }, 404);
  // deletedAt is logged because it IS the undo token: if the client's copy is ever lost (the app
  // restarted, the undo alert dismissed), this line is what makes a manual restore one UPDATE
  // rather than guessing between the distinct deleted_at values on that peer.
  console.log("THREAD_DELETED", JSON.stringify({ peerNumber, messages: hidden, deletedAt, by: staff.email }));
  return jsonResponse({ ok: true, messages: hidden, deletedAt });
}

export async function handleRestoreThread(request: Request, db: D1Database, peerNumber: string, staff: StaffUser): Promise<Response> {
  const denied = forbidden(staff);
  if (denied) return denied;
  let body: { deletedAt?: unknown };
  try {
    body = (await request.json()) as { deletedAt?: unknown };
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }
  const deletedAt = Number(body.deletedAt);
  if (!Number.isFinite(deletedAt) || deletedAt <= 0) {
    return jsonResponse({ error: "deletedAt is required to undo a conversation delete." }, 400);
  }
  const restored = await restoreThread(db, peerNumber, deletedAt);
  if (restored === 0) return jsonResponse({ error: "Nothing to restore." }, 404);
  console.log("THREAD_RESTORED", JSON.stringify({ peerNumber, messages: restored, by: staff.email }));
  return jsonResponse({ ok: true, messages: restored });
}

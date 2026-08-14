import { jsonResponse } from "./respond";
import { getCallDetail, listCalls, listLiveCalls, updateCallMeta } from "../db/calls";

export async function handleListCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listCalls(db));
}

export async function handleUpdateCallMeta(request: Request, db: D1Database, callId: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { disposition?: unknown; notes?: unknown } | null;
  if (!body) return jsonResponse({ error: "invalid request body" }, 400);
  const disposition = typeof body.disposition === "string" ? body.disposition.slice(0, 100) : null;
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 4000) : null;
  const ok = await updateCallMeta(db, callId, { disposition: disposition || null, notes: notes || null });
  return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: "not found" }, 404);
}

export async function handleLiveCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listLiveCalls(db));
}

export async function handleCallDetail(db: D1Database, callId: string): Promise<Response> {
  const detail = await getCallDetail(db, callId);
  if (!detail) return new Response("not found", { status: 404 });
  return jsonResponse(detail);
}

import { jsonResponse } from "./respond";
import { getCallDetail, listCalls, listLiveCalls } from "../db/calls";

export async function handleListCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listCalls(db));
}

export async function handleLiveCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listLiveCalls(db));
}

export async function handleCallDetail(db: D1Database, callId: string): Promise<Response> {
  const detail = await getCallDetail(db, callId);
  if (!detail) return new Response("not found", { status: 404 });
  return jsonResponse(detail);
}

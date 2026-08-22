import { jsonResponse } from "./respond";
import { listConversations, listThread, markThreadRead, insertMessage } from "../db/messages";
import { sendSms } from "../twilio/smsClient";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_FROM_NUMBER: string;
};

// Minimal AU-friendly normalization: keep +E.164 as-is, turn a local 0-prefixed number into +61.
function normalizeNumber(raw: string): string {
  const trimmed = raw.replace(/[\s()-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("0")) return "+61" + trimmed.slice(1);
  return trimmed;
}

export async function handleListConversations(db: D1Database): Promise<Response> {
  return jsonResponse(await listConversations(db));
}

export async function handleGetThread(db: D1Database, peer: string): Promise<Response> {
  await markThreadRead(db, peer);
  return jsonResponse(await listThread(db, peer));
}

export async function handleSendMessage(request: Request, env: Env): Promise<Response> {
  let body: { to?: unknown; body?: unknown };
  try {
    body = (await request.json()) as { to?: unknown; body?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const to = String(body.to ?? "").trim();
  const text = String(body.body ?? "").trim();
  if (!to || !text) return jsonResponse({ error: "Enter a number and a message." }, 400);

  const target = normalizeNumber(to);
  try {
    const { sid } = await sendSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
      to: target,
      from: env.TWILIO_FROM_NUMBER,
      body: text,
    });
    await insertMessage(env.DB, { id: sid, direction: "outbound", peer_number: target, body: text, status: "sent", read: 1, createdAt: Date.now() });
    return jsonResponse({ ok: true, id: sid });
  } catch (e) {
    return jsonResponse({ error: "Could not send the message.", detail: String(e) }, 502);
  }
}

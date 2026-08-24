import { jsonResponse } from "./respond";
import { listConversations, listThread, markThreadRead, insertMessage } from "../db/messages";
import { resolveSendingNumber } from "../db/phoneNumbers";
import { sendSms } from "../twilio/smsClient";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  // SMS uses the US1-region API key: the Messages API is US1-only and the AU1 key/token 401 there.
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
  TWILIO_FROM_NUMBER: string;
  TWILIO_SMS_NUMBER?: string; // SMS-capable number; falls back to the voice number if unset
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

export async function handleGetThread(db: D1Database, peer: string, peek = false): Promise<Response> {
  // peek: read-only preview (call detail) — don't clear the unread badge just by looking, and only
  // return the recent tail (the panel shows 6; don't drag a whole long thread out of D1 for that).
  if (!peek) await markThreadRead(db, peer);
  return jsonResponse(await listThread(db, peer, peek ? 6 : undefined));
}

export async function handleSendMessage(request: Request, env: Env): Promise<Response> {
  let body: { to?: unknown; body?: unknown; from?: unknown };
  try {
    body = (await request.json()) as { to?: unknown; body?: unknown; from?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const to = String(body.to ?? "").trim();
  const text = String(body.body ?? "").trim();
  if (!to || !text) return jsonResponse({ error: "Enter a number and a message." }, 400);

  const target = normalizeNumber(to);
  if (!env.TWILIO_US1_API_KEY_SID || !env.TWILIO_US1_API_KEY_SECRET)
    return jsonResponse({ error: "SMS is not configured." }, 500);
  // "From" number the user picked in the composer (validated against SMS-enabled numbers).
  const requestedFrom = String(body.from ?? "").trim() || null;
  const fromNumber =
    (await resolveSendingNumber(env.DB, "sms", requestedFrom)) ?? env.TWILIO_SMS_NUMBER ?? env.TWILIO_FROM_NUMBER;
  try {
    const { sid } = await sendSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_US1_API_KEY_SID, env.TWILIO_US1_API_KEY_SECRET, {
      to: target,
      from: fromNumber,
      body: text,
    });
    await insertMessage(env.DB, { id: sid, direction: "outbound", peer_number: target, our_number: fromNumber, body: text, status: "sent", read: 1, createdAt: Date.now() });
    return jsonResponse({ ok: true, id: sid });
  } catch (e) {
    return jsonResponse({ error: "Could not send the message.", detail: String(e) }, 502);
  }
}

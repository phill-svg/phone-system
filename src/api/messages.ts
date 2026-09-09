import { jsonResponse } from "./respond";
import { listConversations, listThread, markThreadRead, insertMessage } from "../db/messages";
import { resolveSendingNumber } from "../db/phoneNumbers";
import { sendSms } from "../twilio/smsClient";
import { appendWebhookSecret } from "../twilio/webhookAuth";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  // SMS uses the US1-region API key: the Messages API is US1-only and the AU1 key/token 401 there.
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
  TWILIO_FROM_NUMBER: string;
  TWILIO_SMS_NUMBER?: string; // SMS-capable number; falls back to the voice number if unset
  // Facebook Messenger sender for outbound replies, e.g. "messenger:<page-id>". Inbound Messenger
  // arrives via Twilio as From="messenger:<PSID>" (stored as peer_number); replies must go back out
  // FROM the Page's messenger address, not a phone number.
  TWILIO_MESSENGER_FROM?: string;
  TWILIO_WEBHOOK_SECRET?: string;
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

  // A Facebook Messenger peer ("messenger:<PSID>") replies out through the Twilio Messenger channel
  // from the Page's messenger address; a normal SMS peer is phone-normalized and sent from a number.
  const isMessenger = to.startsWith("messenger:");
  const target = isMessenger ? to : normalizeNumber(to);
  if (!env.TWILIO_US1_API_KEY_SID || !env.TWILIO_US1_API_KEY_SECRET)
    return jsonResponse({ error: "SMS is not configured." }, 500);
  let fromNumber: string;
  if (isMessenger) {
    if (!env.TWILIO_MESSENGER_FROM)
      return jsonResponse({ error: "Messenger sending is not configured." }, 500);
    fromNumber = env.TWILIO_MESSENGER_FROM;
  } else {
    // "From" number the user picked in the composer (validated against SMS-enabled numbers).
    const requestedFrom = String(body.from ?? "").trim() || null;
    fromNumber =
      (await resolveSendingNumber(env.DB, "sms", requestedFrom)) ?? env.TWILIO_SMS_NUMBER ?? env.TWILIO_FROM_NUMBER;
  }
  // Twilio's 201 on this call only means "accepted" -- for Messenger sends in particular, Meta
  // can still reject the message asynchronously (most commonly for replying outside the 24-hour
  // window). Point Twilio at our status callback so that outcome ever reaches `messages.status`
  // instead of the app permanently showing "sent" for a message that never actually delivered.
  const statusCallback = appendWebhookSecret(
    `${new URL(request.url).origin}/webhooks/twilio/sms-status`,
    env.TWILIO_WEBHOOK_SECRET
  );
  let sid: string;
  try {
    ({ sid } = await sendSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_US1_API_KEY_SID, env.TWILIO_US1_API_KEY_SECRET, {
      to: target,
      from: fromNumber,
      body: text,
      statusCallback,
    }));
  } catch (e) {
    return jsonResponse({ error: "Could not send the message.", detail: String(e) }, 502);
  }
  // sendSms only throws on !res.ok, so a 2xx whose body carries no sid would otherwise fall through
  // as a success with no id -- and splitting the try/catch below is exactly what would turn that
  // from a visible 502 into a silent one.
  if (!sid) return jsonResponse({ error: "Twilio accepted the message but returned no id." }, 502);

  // Deliberately OUTSIDE the send try. Twilio has accepted the message by this point -- the
  // customer is going to receive it -- so a D1 failure here is a bookkeeping failure, not a send
  // failure, and reporting it as "Could not send" makes staff resend and the customer get it twice.
  // Worse, the row would never exist, so the status callback for this sid is a permanent no-op and
  // the message never appears in the thread at all.
  try {
    await insertMessage(env.DB, { id: sid, direction: "outbound", peer_number: target, our_number: fromNumber, body: text, status: "sent", read: 1, createdAt: Date.now() });
  } catch (e) {
    console.log(
      "MESSAGE_INSERT_FAILED",
      JSON.stringify({ sid, peer: target, error: e instanceof Error ? e.message : String(e) })
    );
  }
  return jsonResponse({ ok: true, id: sid });
}

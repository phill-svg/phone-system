import { jsonResponse } from "./respond";
import { upsertPushToken, deletePushTokens, getPushTokensForType } from "../db/pushTokens";
import { findContactByPhone } from "../db/contacts";
import { sendExpoPush } from "../push/expoPush";
import type { StaffUser } from "../access/requireStaffUser";

// A device registers its Expo push token so it can be notified of inbound SMS etc.
export async function handleRegisterPushToken(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  let body: { token?: unknown; platform?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; platform?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const token = String(body.token ?? "").trim();
  const platform = String(body.platform ?? "unknown").trim();
  if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) {
    return jsonResponse({ error: "invalid push token" }, 400);
  }
  await upsertPushToken(db, { token, platform, staffEmail: staff.email, now: Date.now() });
  return jsonResponse({ ok: true });
}

// Fire-and-forget: notify all registered devices about an inbound text. Prunes dead tokens.
// `nameOverride` lets callers pass an already-resolved display name (e.g. a cached Facebook
// Messenger sender name) that takes priority over the phone-number contact lookup below.
export async function notifyInboundSms(
  db: D1Database,
  from: string,
  bodyText: string,
  nameOverride?: string | null
): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_sms");
  if (tokens.length === 0) return;
  // Show the saved contact name if we have one, otherwise fall back to the raw number.
  const contact = await findContactByPhone(db, from);
  const sender = nameOverride || contact?.name || from;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `New message from ${sender}`,
    body: bodyText.slice(0, 240) || "New message",
    data: { type: "sms", from },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}

// Fire-and-forget: notify staff of a call nobody answered. Prunes dead tokens.
export async function notifyMissedCall(db: D1Database, callerNumber: string): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_missed");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, callerNumber);
  const who = contact?.name || callerNumber;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `Missed call from ${who}`,
    body: "Nobody answered this call.",
    data: { type: "missed_call", from: callerNumber },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}

// Fire-and-forget: notify staff that a caller left a voicemail. Prunes dead tokens.
export async function notifyVoicemail(db: D1Database, callerNumber: string): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_voicemail");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, callerNumber);
  const who = contact?.name || callerNumber;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `New voicemail from ${who}`,
    body: "Tap to listen.",
    data: { type: "voicemail", from: callerNumber },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}

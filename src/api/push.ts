import { jsonResponse } from "./respond";
import { upsertPushToken, deletePushTokens, getPushTokensForType } from "../db/pushTokens";
import { findContactByPhone } from "../db/contacts";
import { sendExpoPush } from "../push/expoPush";
import type { StaffUser } from "../access/requireStaffUser";

// A build identifier is a short token ("67", "5"), and whatever arrives here is read back into
// every line of Admin > Health Checks. Cap it rather than store an unbounded string a client chose:
// this is client-supplied text on a write path, and the only bound otherwise is the request size.
const MAX_BUILD_TAG = 32;
const buildTag = (v: unknown): string | null => (typeof v === "string" ? v.trim().slice(0, MAX_BUILD_TAG) : null);

// A device registers its Expo push token so it can be notified of inbound SMS etc.
export async function handleRegisterPushToken(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  let body: { token?: unknown; platform?: unknown; otaBuild?: unknown; nativeBuild?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const token = String(body.token ?? "").trim();
  const platform = String(body.platform ?? "unknown").trim();
  if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) {
    return jsonResponse({ error: "invalid push token" }, 400);
  }
  // Which build this handset is running, recorded here because push registration is the one thing
  // every signed-in handset does on launch. The native build is what says whether a NATIVE fix is
  // installed -- an OTA can never deliver the CallKit AppDelegate patch, so the OTA number alone
  // cannot answer "why didn't my phone ring?". Both are optional: an older handset simply omits
  // them and upsertPushToken keeps whatever it already knew.
  await upsertPushToken(db, {
    token,
    platform,
    staffEmail: staff.email,
    now: Date.now(),
    otaBuild: buildTag(body.otaBuild),
    nativeBuild: buildTag(body.nativeBuild),
  });
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
  // Show the saved contact name if we have one, otherwise fall back to the raw number -- except
  // for a Messenger sender we have no name for, where the raw value is "messenger:<psid>". That is
  // meaningless in a notification, so use the same "Facebook user" placeholder the inbox shows.
  const contact = await findContactByPhone(db, from);
  const sender = nameOverride || contact?.name || (from.startsWith("messenger:") ? "Facebook user" : from);
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

// Fire-and-forget: a call is ringing a staff member's MOBILE right now.
//
// The one thing the carrier ring cannot say. With divert_caller_id on (the default) the mobile
// presents the CUSTOMER's number, which is what you want for calling back -- but it makes a work
// call indistinguishable from a personal one until you answer and hear the "T C B call." whisper.
// This lands on the lock screen alongside the ring and closes that gap.
//
// Only the divert path calls it. A softphone leg already shows a full CallKit incoming screen
// saying who it is, so this there would be duplicate noise.
//
// `notif_incoming` has existed in user_settings since the settings foundation shipped, defaulted
// on, shown in the app -- and until now NOTHING read it. Every other notif_ key had a notifyX()
// behind it; this was a dead switch.
export async function notifyIncomingCall(db: D1Database, callerNumber: string): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_incoming");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, callerNumber);
  const who = contact?.name || callerNumber;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `TCB call from ${who}`,
    body: "Ringing your mobile now.",
    data: { type: "incoming_call", from: callerNumber },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}

// Fire-and-forget: notify staff that an outbound message (SMS or Messenger) failed to deliver --
// Twilio's initial "sent" only means accepted, so this is the only alert staff get for a send that
// actually bounced (e.g. a broken Facebook channel connection, error 63001). Prunes dead tokens.
export async function notifyMessageFailed(
  db: D1Database,
  peer: string,
  detail: string | null
): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_sms");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, peer);
  const who = contact?.name || (peer.startsWith("messenger:") ? "a Facebook contact" : peer);
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: "Message not delivered",
    body: detail ? `To ${who}: ${detail}` : `A message to ${who} failed to send.`,
    data: { type: "message_failed", from: peer },
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

// Fire-and-forget: notify staff that a caller asked to be rung back. Prunes dead tokens.
// Without this a callback request lands silently in the table and nobody knows it is there --
// which is exactly how one sat unactioned for two days before the app grew a screen for them.
export async function notifyCallbackRequest(db: D1Database, callerNumber: string): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_callback");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, callerNumber);
  const who = contact?.name || callerNumber;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `${who} asked for a callback`,
    body: "Tap to see the callback list.",
    data: { type: "callback_request", from: callerNumber },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}

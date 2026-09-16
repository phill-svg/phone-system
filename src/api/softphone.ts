import { jsonResponse } from "./respond";
import { mintAccessToken } from "../twilio/accessToken";
import { appendWebhookSecret } from "../twilio/webhookAuth";
import { setStaffStatus, touchHeartbeat } from "../db/staff";
import { resolveSendingNumber } from "../db/phoneNumbers";

// A resolved sending number, or null if it is not a plausible E.164 number Twilio would accept.
export function validCallerId(resolved: string | null): string | null {
  const n = (resolved ?? "").trim();
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}
import { recordCallLeg, ownLegConference } from "../db/callLegs";
import type { StaffUser } from "../access/requireStaffUser";
import {
  findConferenceSid as realFindConferenceSid,
  listParticipants as realListParticipants,
  setParticipantHold as realSetParticipantHold,
  removeParticipant as realRemoveParticipant,
} from "../twilio/conferenceClient";
import { createOutboundCall as realCreateOutboundCall } from "../twilio/restClient";
import { localDateKey } from "../ivr/businessHours";

type Env = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_TWIML_APP_SID: string;
  TWILIO_PUSH_CREDENTIAL_SID_IOS?: string;
  TWILIO_PUSH_CREDENTIAL_SID_ANDROID?: string;
};

export async function handleGetSoftphoneToken(env: Env, staff: StaffUser, platform?: string): Promise<Response> {
  const pushCredentialSid =
    platform === "ios" ? env.TWILIO_PUSH_CREDENTIAL_SID_IOS
    : platform === "android" ? env.TWILIO_PUSH_CREDENTIAL_SID_ANDROID
    : undefined;
  const token = await mintAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY_SID,
    apiKeySecret: env.TWILIO_API_KEY_SECRET,
    twimlAppSid: env.TWILIO_TWIML_APP_SID,
    identity: staff.email,
    pushCredentialSid,
  });
  return jsonResponse({ token });
}

function isValidStatus(value: unknown): value is "available" | "away" | "offline" {
  return value === "available" || value === "away" || value === "offline";
}

export async function handlePutPresence(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { status, awayReason } = body as Record<string, unknown>;
  if (!isValidStatus(status)) return new Response("invalid request body", { status: 400 });
  if (awayReason !== undefined && typeof awayReason !== "string" && awayReason !== null) {
    return new Response("invalid request body", { status: 400 });
  }
  // Stamped with today's Canberra date: the override lasts for the rest of this local day and
  // the cron puts them back to available afterwards (see resetAvailabilityForNewDay).
  // Passed through as `undefined` when the field was absent, NOT collapsed to null. An absent
  // field means the caller is not talking about the reason: the web Away button sets the status
  // without touching a reason already typed, and the handset (which sends `{status}` only) keeps
  // one too. Sending an explicit null still clears it, which is what Available/Offline do.
  await setStaffStatus(
    db,
    staff.email,
    status,
    awayReason as string | null | undefined,
    localDateKey(new Date())
  );
  return jsonResponse({ ok: true });
}

export async function handlePostHeartbeat(db: D1Database, staff: StaffUser): Promise<Response> {
  await touchHeartbeat(db, staff.email);
  return jsonResponse({ ok: true });
}

type TwilioEnv = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string };

type ConferenceDeps = {
  findConferenceSid: typeof realFindConferenceSid;
  listParticipants: typeof realListParticipants;
  setParticipantHold: typeof realSetParticipantHold;
};

export async function handlePostHold(
  request: Request,
  env: TwilioEnv,
  staff: StaffUser,
  db: D1Database,
  deps: ConferenceDeps = {
    findConferenceSid: realFindConferenceSid,
    listParticipants: realListParticipants,
    setParticipantHold: realSetParticipantHold,
  }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  // A body `conferenceName` is ignored: the leg record knows the real one, and a client cannot --
  // an inbound call's conference is named after the caller's leg, so every inbound hold used to 404.
  const { selfCallSid, hold } = body as Record<string, unknown>;
  if (typeof selfCallSid !== "string" || typeof hold !== "boolean") {
    return new Response("invalid request body", { status: 400 });
  }
  // Bind the claimed leg to the AUTHENTICATED staff identity -- never trust a body-supplied email.
  // This closes the gap where a staff member reads a colleague's live-call CallSid (via
  // GET /api/calls/live) and submits it as their OWN selfCallSid: it's a genuine participant, but
  // it was never dialed/received on THIS staff member's behalf.
  const conferenceName = await ownLegConference(db, selfCallSid, staff.email);
  if (!conferenceName) return new Response("not your call leg", { status: 403 });
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  const participants = await deps.listParticipants(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid);
  if (!participants.some((p) => p.callSid === selfCallSid)) {
    return new Response("not a participant in this conference", { status: 403 });
  }
  const others = participants.filter((p) => p.callSid !== selfCallSid);
  for (const other of others) {
    await deps.setParticipantHold(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, other.callSid, hold);
  }
  return jsonResponse({ ok: true });
}

type OutboundEnv = TwilioEnv & {
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_WEBHOOK_SECRET?: string;
  TWILIO_FROM_NUMBER: string;
};
type DialDeps = {
  createOutboundCall: typeof realCreateOutboundCall;
  findConferenceSid: typeof realFindConferenceSid;
  listParticipants: typeof realListParticipants;
};
type RemoveDeps = {
  findConferenceSid: typeof realFindConferenceSid;
  listParticipants: typeof realListParticipants;
  removeParticipant: typeof realRemoveParticipant;
};

export async function handlePostTransfer(
  request: Request,
  env: OutboundEnv,
  staff: StaffUser,
  origin: string,
  db: D1Database,
  deps: DialDeps = {
    createOutboundCall: realCreateOutboundCall,
    findConferenceSid: realFindConferenceSid,
    listParticipants: realListParticipants,
  }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  // A body `conferenceName` is ignored, as for hold: an inbound call's conference is named after the
  // caller's leg, so the client's guess dialled the colleague into a conference nobody was in.
  const { targetEmail, agentCallSid } = body as Record<string, unknown>;
  if (typeof targetEmail !== "string" || typeof agentCallSid !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  // Bind the claimed leg to the AUTHENTICATED requester -- never trust a body-supplied email.
  const conferenceName = await ownLegConference(db, agentCallSid, staff.email);
  if (!conferenceName) return new Response("not your call leg", { status: 403 });
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  const participants = await deps.listParticipants(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid);
  if (!participants.some((p) => p.callSid === agentCallSid)) {
    return new Response("not a participant in this conference", { status: 403 });
  }
  // Same source as every other outbound leg -- TWILIO_FROM_NUMBER is the original build number and
  // stopped being the business's caller ID when the landline ported in. Shape-checked for the same
  // reason as the ring path: phone_numbers is admin-editable and nothing validates a row against
  // Twilio, so a typo'd default would 400 every transfer.
  const fromNumber = validCallerId(await resolveSendingNumber(db, "voice", null)) ?? env.TWILIO_FROM_NUMBER;
  const { sid } = await deps.createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
    // CallerNumber rides along the same way dialStaff sends it -- the mobile app's native call
    // notification template (setIncomingCallContactHandleTemplate) reads this key globally, on
    // every client: leg, incoming or transferred. Without it a transfer invite renders blank
    // instead of the business number a colleague would otherwise see here.
    to: `client:${targetEmail}?CallerNumber=${encodeURIComponent(fromNumber.replace(/^\+/, ""))}`,
    from: fromNumber,
    url: appendWebhookSecret(`${origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
  });
  // Staff-gate the transferred-to leg for the TARGET staff member, before they even exist as a
  // real conference participant, so a subsequent hold/transfer/complete-transfer they make can
  // itself be verified via ownLegConference.
  await recordCallLeg(db, sid, targetEmail, conferenceName);
  return jsonResponse({ sid });
}

export async function handlePostCompleteTransfer(
  request: Request,
  env: TwilioEnv,
  staff: StaffUser,
  db: D1Database,
  deps: RemoveDeps = {
    findConferenceSid: realFindConferenceSid,
    listParticipants: realListParticipants,
    removeParticipant: realRemoveParticipant,
  }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  // Completing a transfer means the requester LEAVES, so the leg removed is always their own. Body
  // `callSid` and `conferenceName` are ignored: removing `callSid` as given let anyone holding a real
  // leg name the customer's sid and hang up on them, and the conference comes from the leg record.
  const { selfCallSid } = body as Record<string, unknown>;
  if (typeof selfCallSid !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  // Bind the claimed leg to the AUTHENTICATED requester -- never trust a body-supplied email.
  const conferenceName = await ownLegConference(db, selfCallSid, staff.email);
  if (!conferenceName) return new Response("not your call leg", { status: 403 });
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  const participants = await deps.listParticipants(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid);
  if (!participants.some((p) => p.callSid === selfCallSid)) {
    return new Response("not a participant in this conference", { status: 403 });
  }
  // The colleague only becomes a participant once they answer. Leaving before that leaves the customer
  // alone, and cleanupLoneConference then ends the conference on them -- so refuse.
  // ponytail: a muted listen-in supervisor counts as the third party; tell them apart if that bites.
  if (participants.length < 3) {
    return jsonResponse({ error: "Your colleague hasn't answered yet." }, 409);
  }
  await deps.removeParticipant(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, selfCallSid);
  return jsonResponse({ ok: true });
}

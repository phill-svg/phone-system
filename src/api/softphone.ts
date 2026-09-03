import { jsonResponse } from "./respond";
import { mintAccessToken } from "../twilio/accessToken";
import { appendWebhookSecret } from "../twilio/webhookAuth";
import { setStaffStatus, touchHeartbeat } from "../db/staff";
import { recordCallLeg, isOwnLeg } from "../db/callLegs";
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
  await setStaffStatus(
    db,
    staff.email,
    status,
    (awayReason as string | null | undefined) ?? null,
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
  const { conferenceName, selfCallSid, hold } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof selfCallSid !== "string" || typeof hold !== "boolean") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  // Bind the claimed leg to the AUTHENTICATED staff identity -- never trust a body-supplied email.
  // This closes the gap where a staff member reads a colleague's live-call CallSid (via
  // GET /api/calls/live) and submits it as their OWN selfCallSid: it's a genuine participant, but
  // it was never dialed/received on THIS staff member's behalf.
  if (!(await isOwnLeg(db, selfCallSid, staff.email))) {
    return new Response("not your call leg", { status: 403 });
  }
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
  const { conferenceName, targetEmail, agentCallSid } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof targetEmail !== "string" || typeof agentCallSid !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  // Bind the claimed leg to the AUTHENTICATED requester -- never trust a body-supplied email.
  if (!(await isOwnLeg(db, agentCallSid, staff.email))) {
    return new Response("not your call leg", { status: 403 });
  }
  const participants = await deps.listParticipants(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid);
  if (!participants.some((p) => p.callSid === agentCallSid)) {
    return new Response("not a participant in this conference", { status: 403 });
  }
  const { sid } = await deps.createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
    to: `client:${targetEmail}`,
    from: env.TWILIO_FROM_NUMBER,
    url: appendWebhookSecret(`${origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
  });
  // Staff-gate the transferred-to leg for the TARGET staff member, before they even exist as a
  // real conference participant, so a subsequent hold/transfer/complete-transfer they make can
  // itself be verified via isOwnLeg.
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
  const { conferenceName, callSid, selfCallSid } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof callSid !== "string" || typeof selfCallSid !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  // Bind the claimed leg to the AUTHENTICATED requester -- never trust a body-supplied email.
  if (!(await isOwnLeg(db, selfCallSid, staff.email))) {
    return new Response("not your call leg", { status: 403 });
  }
  const participants = await deps.listParticipants(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid);
  if (!participants.some((p) => p.callSid === selfCallSid)) {
    return new Response("not a participant in this conference", { status: 403 });
  }
  await deps.removeParticipant(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, callSid);
  return jsonResponse({ ok: true });
}

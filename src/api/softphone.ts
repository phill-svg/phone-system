import { jsonResponse } from "./respond";
import { mintAccessToken } from "../twilio/accessToken";
import { setStaffStatus, touchHeartbeat } from "../db/staff";
import type { StaffUser } from "../access/requireStaffUser";
import {
  findConferenceSid as realFindConferenceSid,
  setParticipantHold as realSetParticipantHold,
  removeParticipant as realRemoveParticipant,
} from "../twilio/conferenceClient";
import { createOutboundCall as realCreateOutboundCall } from "../twilio/restClient";

type Env = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_TWIML_APP_SID: string;
};

export async function handleGetSoftphoneToken(env: Env, staff: StaffUser): Promise<Response> {
  const token = await mintAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY_SID,
    apiKeySecret: env.TWILIO_API_KEY_SECRET,
    twimlAppSid: env.TWILIO_TWIML_APP_SID,
    identity: staff.email,
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
  await setStaffStatus(db, staff.email, status, (awayReason as string | null | undefined) ?? null);
  return jsonResponse({ ok: true });
}

export async function handlePostHeartbeat(db: D1Database, staff: StaffUser): Promise<Response> {
  await touchHeartbeat(db, staff.email);
  return jsonResponse({ ok: true });
}

type TwilioEnv = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string };

type ConferenceDeps = {
  findConferenceSid: typeof realFindConferenceSid;
  setParticipantHold: typeof realSetParticipantHold;
};

export async function handlePostHold(
  request: Request,
  env: TwilioEnv,
  _staff: StaffUser,
  deps: ConferenceDeps = { findConferenceSid: realFindConferenceSid, setParticipantHold: realSetParticipantHold }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { conferenceName, callSid, hold } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof callSid !== "string" || typeof hold !== "boolean") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  await deps.setParticipantHold(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, callSid, hold);
  return jsonResponse({ ok: true });
}

type OutboundEnv = TwilioEnv & { TWILIO_FROM_NUMBER: string };
type DialDeps = { createOutboundCall: typeof realCreateOutboundCall };
type RemoveDeps = { findConferenceSid: typeof realFindConferenceSid; removeParticipant: typeof realRemoveParticipant };

export async function handlePostTransfer(
  request: Request,
  env: OutboundEnv,
  _staff: StaffUser,
  origin: string,
  deps: DialDeps = { createOutboundCall: realCreateOutboundCall }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { conferenceName, targetEmail } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof targetEmail !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  const { sid } = await deps.createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
    to: `client:${targetEmail}`,
    from: env.TWILIO_FROM_NUMBER,
    url: `${origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}`,
  });
  return jsonResponse({ sid });
}

export async function handlePostCompleteTransfer(
  request: Request,
  env: TwilioEnv,
  _staff: StaffUser,
  deps: RemoveDeps = { findConferenceSid: realFindConferenceSid, removeParticipant: realRemoveParticipant }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { conferenceName, callSid } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof callSid !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  await deps.removeParticipant(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, callSid);
  return jsonResponse({ ok: true });
}

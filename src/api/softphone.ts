import { jsonResponse } from "./respond";
import { mintAccessToken } from "../twilio/accessToken";
import { setStaffStatus, touchHeartbeat } from "../db/staff";
import type { StaffUser } from "../access/requireStaffUser";

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

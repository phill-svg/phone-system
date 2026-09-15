import { jsonResponse } from "./respond";
import {
  getBusinessHours,
  getCallBlocklist,
  setBusinessHours,
  setCallBlocklist,
  getRecordingEnabled,
  setRecordingEnabled,
  getDivertCallerId,
  setDivertCallerId,
  getMissedCallSms,
  setMissedCallSms,
} from "../db/settings";
import { isBusinessHoursSchedule } from "../ivr/businessHours";
import type { BusinessHoursSchedule } from "../ivr/businessHours";
import type { StaffUser } from "../access/requireStaffUser";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function forbiddenUnlessAdmin(staff: StaffUser): Response | null {
  if (staff.role !== "admin") {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

const INVALID_BODY_RESPONSE = () => new Response("invalid request body", { status: 400 });

export async function handleGetBusinessHours(db: D1Database): Promise<Response> {
  return jsonResponse(await getBusinessHours(db));
}

export async function handlePutBusinessHours(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (!isBusinessHoursSchedule(body)) {
    return INVALID_BODY_RESPONSE();
  }
  await setBusinessHours(db, body);
  return jsonResponse({ ok: true });
}

export async function handleGetCallBlocklist(db: D1Database): Promise<Response> {
  return jsonResponse(await getCallBlocklist(db));
}

export async function handlePutCallBlocklist(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (!isStringArray(body)) return INVALID_BODY_RESPONSE();
  await setCallBlocklist(db, body);
  return jsonResponse({ ok: true });
}

export async function handleGetRecordingSetting(db: D1Database): Promise<Response> {
  return jsonResponse({ recording_enabled: await getRecordingEnabled(db) });
}

export async function handlePutRecordingSetting(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (typeof body !== "object" || body === null || typeof (body as { recording_enabled?: unknown }).recording_enabled !== "boolean") {
    return INVALID_BODY_RESPONSE();
  }
  await setRecordingEnabled(db, (body as { recording_enabled: boolean }).recording_enabled);
  return jsonResponse({ ok: true });
}

export async function handleGetDivertCallerIdSetting(db: D1Database): Promise<Response> {
  return jsonResponse({ divert_caller_id: await getDivertCallerId(db) });
}

export async function handlePutDivertCallerIdSetting(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (typeof body !== "object" || body === null || typeof (body as { divert_caller_id?: unknown }).divert_caller_id !== "boolean") {
    return INVALID_BODY_RESPONSE();
  }
  await setDivertCallerId(db, (body as { divert_caller_id: boolean }).divert_caller_id);
  return jsonResponse({ ok: true });
}

// SMS segments bill per ~160 (GSM-7) or ~70 (with an emoji/non-GSM char) characters, so an
// unbounded template is an unbounded per-missed-call cost. 320 is roughly two GSM-7 segments --
// generous for "sorry we missed you, we'll call back" without leaving the field able to bill for
// a small novel on every miss.
const MAX_MISSED_CALL_SMS_TEMPLATE = 320;

export async function handleGetMissedCallSmsSetting(db: D1Database): Promise<Response> {
  return jsonResponse(await getMissedCallSms(db));
}

export async function handlePutMissedCallSmsSetting(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (typeof body !== "object" || body === null) return INVALID_BODY_RESPONSE();
  const { enabled, template } = body as { enabled?: unknown; template?: unknown };
  if (typeof enabled !== "boolean" || typeof template !== "string") return INVALID_BODY_RESPONSE();
  const trimmed = template.trim();
  if (trimmed.length > MAX_MISSED_CALL_SMS_TEMPLATE) {
    return jsonResponse({ error: `Message must be ${MAX_MISSED_CALL_SMS_TEMPLATE} characters or fewer.` }, 400);
  }
  if (enabled && !trimmed) {
    return jsonResponse({ error: "Enter a message to send before turning this on." }, 400);
  }
  await setMissedCallSms(db, { enabled, template: trimmed });
  return jsonResponse({ ok: true });
}

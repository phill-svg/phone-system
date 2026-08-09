import { jsonResponse } from "./respond";
import { getBusinessHours, getStaffRingList, setBusinessHours, setStaffRingList } from "../db/settings";
import type { StaffRingEntry } from "../db/settings";
import type { BusinessHoursSchedule, DayWindow } from "../ivr/businessHours";
import type { StaffUser } from "../access/requireStaffUser";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_RE = /^\d{2}:\d{2}$/;

function isDayWindow(value: unknown): value is DayWindow {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window.open === "string" &&
    TIME_RE.test(window.open) &&
    typeof window.close === "string" &&
    TIME_RE.test(window.close)
  );
}

function isBusinessHoursSchedule(value: unknown): value is BusinessHoursSchedule {
  if (typeof value !== "object" || value === null) return false;
  const schedule = value as Record<string, unknown>;
  const keys = Object.keys(schedule);
  if (keys.length !== DAY_KEYS.length) return false;
  return DAY_KEYS.every((day) => Object.prototype.hasOwnProperty.call(schedule, day) && isDayWindow(schedule[day]));
}

function isStaffRingList(value: unknown): value is StaffRingEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || typeof item.number !== "string") return false;
    if ("isOnCall" in item && typeof item.isOnCall !== "boolean") return false;
    return true;
  });
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

export async function handleGetStaffRingList(db: D1Database): Promise<Response> {
  return jsonResponse(await getStaffRingList(db));
}

export async function handlePutStaffRingList(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (!isStaffRingList(body)) {
    return INVALID_BODY_RESPONSE();
  }
  await setStaffRingList(db, body);
  return jsonResponse({ ok: true });
}

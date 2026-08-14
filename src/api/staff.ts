import { jsonResponse } from "./respond";
import { getStaffRoster, setStaffSchedule, setStaffMobile, setStaffPriority } from "../db/staff";
import { toDiallableNumber } from "../dial/ringQueue";
import type { StaffUser } from "../access/requireStaffUser";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_RE = /^\d{2}:\d{2}$/;

function isDayWindow(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return typeof w.open === "string" && TIME_RE.test(w.open) && typeof w.close === "string" && TIME_RE.test(w.close);
}

function isSchedule(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return DAY_KEYS.length === Object.keys(s).length && DAY_KEYS.every((d) => Object.prototype.hasOwnProperty.call(s, d) && isDayWindow(s[d]));
}

export async function handleGetStaffRoster(db: D1Database): Promise<Response> {
  const roster = await getStaffRoster(db);
  return jsonResponse(roster.map((s) => ({ email: s.email, role: s.role, status: s.status })));
}

export async function handlePutStaffSchedule(request: Request, db: D1Database, email: string, staff: StaffUser): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (!isSchedule(body)) return new Response("invalid request body", { status: 400 });
  await setStaffSchedule(db, email, body as any);
  return jsonResponse({ ok: true });
}

// Set/clear a staff member's PSTN failover mobile. An admin can edit anyone's; a non-admin may
// only edit their own.
export async function handlePutStaffMobile(request: Request, db: D1Database, email: string, staff: StaffUser): Promise<Response> {
  if (staff.role !== "admin" && staff.email !== email) return new Response("forbidden", { status: 403 });
  let body: { mobile?: unknown };
  try {
    body = (await request.json()) as { mobile?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const raw = typeof body.mobile === "string" ? body.mobile.trim() : "";
  if (raw && toDiallableNumber(raw) === null) {
    return jsonResponse({ error: "That doesn't look like a valid phone number." }, 400);
  }
  await setStaffMobile(db, email, raw || null);
  return jsonResponse({ ok: true });
}

// Set a staff member's cascade ring priority (lower rings earlier). Admin only.
export async function handlePutStaffPriority(request: Request, db: D1Database, email: string, staff: StaffUser): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: { priority?: unknown };
  try {
    body = (await request.json()) as { priority?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const priority = Number(body.priority);
  if (!Number.isFinite(priority) || priority < 0 || priority > 9999) {
    return jsonResponse({ error: "Priority must be a number between 0 and 9999." }, 400);
  }
  await setStaffPriority(db, email, priority);
  return jsonResponse({ ok: true });
}

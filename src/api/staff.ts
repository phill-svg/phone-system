import { jsonResponse } from "./respond";
import { getStaffRoster, setStaffSchedule, setStaffPriority, setStaffStatus, createInvitedStaff, deleteStaff } from "../db/staff";
import type { StaffUser } from "../access/requireStaffUser";
import { issueToken } from "../access/passwordTokens";
import { sendEmail, inviteEmail, resetEmail, type SendEmailBinding } from "../email/sendgrid";
import { destroySessionsForEmail } from "../access/session";

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

// Admin override of a staff member's availability. "away" force-benches them from the ring
// cascade; "available" clears the override (they still also need a live app/heartbeat to ring).
export async function handlePutStaffStatus(request: Request, db: D1Database, email: string, staff: StaffUser): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: { status?: unknown };
  try {
    body = (await request.json()) as { status?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (body.status !== "available" && body.status !== "away") {
    return jsonResponse({ error: "Status must be 'available' or 'away'." }, 400);
  }
  await setStaffStatus(db, email, body.status, null);
  return jsonResponse({ ok: true });
}

type StaffAdminEnv = { DB: D1Database; EMAIL?: SendEmailBinding };

const EMAIL_RE = /^[^@\s'"<>();\\`]+@[^@\s'"<>();\\`]+\.[^@\s'"<>();\\`]+$/;

export async function handleInviteStaff(request: Request, env: StaffAdminEnv, staff: StaffUser, origin: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: { email?: unknown; role?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; role?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = body.role === "admin" ? "admin" : "staff";
  if (!EMAIL_RE.test(email)) return jsonResponse({ error: "Enter a valid email address." }, 400);

  await createInvitedStaff(env.DB, email, role);
  const token = await issueToken(env.DB, email, "invite");
  const { subject, html } = inviteEmail(`${origin}/set-password?token=${token}`);
  try {
    await sendEmail(env, { to: email, subject, html });
  } catch (e) {
    console.error("INVITE_EMAIL_SEND_FAILED", String(e));
    return jsonResponse({ error: "User created, but the invite email failed to send. Use 'Resend invite'.", detail: String(e) }, 502);
  }
  return jsonResponse({ ok: true });
}

export async function handleResendInvite(env: StaffAdminEnv, staff: StaffUser, email: string, origin: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  const user = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(email).first<{ email: string }>();
  if (!user) return jsonResponse({ error: "No such staff member." }, 404);
  const token = await issueToken(env.DB, user.email, "invite");
  const { subject, html } = inviteEmail(`${origin}/set-password?token=${token}`);
  try {
    await sendEmail(env, { to: user.email, subject, html });
  } catch (e) {
    return jsonResponse({ error: "Failed to send invite email.", detail: String(e) }, 502);
  }
  return jsonResponse({ ok: true });
}

export async function handleSendReset(env: StaffAdminEnv, staff: StaffUser, email: string, origin: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  const user = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(email).first<{ email: string }>();
  if (!user) return jsonResponse({ error: "No such staff member." }, 404);
  const token = await issueToken(env.DB, user.email, "reset");
  const { subject, html } = resetEmail(`${origin}/set-password?token=${token}`);
  try {
    await sendEmail(env, { to: user.email, subject, html });
  } catch (e) {
    return jsonResponse({ error: "Failed to send reset email.", detail: String(e) }, 502);
  }
  return jsonResponse({ ok: true });
}

export async function handleRemoveStaff(env: StaffAdminEnv, staff: StaffUser, email: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  if (email.toLowerCase() === staff.email.toLowerCase()) {
    return jsonResponse({ error: "You can't remove your own account." }, 400);
  }
  await destroySessionsForEmail(env.DB, email);
  await env.DB.prepare("DELETE FROM password_tokens WHERE email = ?").bind(email).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
  await deleteStaff(env.DB, email);
  return jsonResponse({ ok: true });
}

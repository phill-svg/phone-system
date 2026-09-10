import { jsonResponse } from "./respond";
import { excludeEmails as excludeList } from "../demo";
import { getStaffRoster, setStaffSchedule, setStaffPriority, setStaffStatus, createInvitedStaff, deleteStaff, listStaffAccess } from "../db/staff";
import type { StaffUser } from "../access/requireStaffUser";
import { issueToken, invalidateTokensForEmail } from "../access/passwordTokens";
import { clearAttempts } from "../access/loginAttempts";
import { sendEmail, inviteEmail, resetEmail, type SendEmailBinding } from "../email/sendgrid";
import { destroySessionsForEmail } from "../access/session";
import { isBusinessHoursSchedule } from "../ivr/businessHours";

// `excludeEmails` drops the App Review demo account: it is not a colleague, so it should not
// appear in the softphone's transfer picker where someone could hand it a real customer's call.
export async function handleGetStaffRoster(db: D1Database, excludeEmails: string[]): Promise<Response> {
  const roster = excludeList(await getStaffRoster(db), excludeEmails);
  return jsonResponse(roster.map((s) => ({ email: s.email, role: s.role, status: s.status })));
}

// Everything the admin surfaces need about every staff member, in one request: schedule, ring
// order, availability and whether they have set a password yet. The web Settings page gets this
// server-rendered; the mobile app can't, and the plain roster above deliberately omits all of it
// so an ordinary softphone can't read the team's hours. Admin-gated at the router (/api/admin/*).
export async function handleGetStaffAdminList(db: D1Database): Promise<Response> {
  const [roster, access] = await Promise.all([getStaffRoster(db), listStaffAccess(db)]);
  const hasPassword = new Map(access.map((a) => [a.email, a.hasPassword]));
  return jsonResponse(
    [...roster]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((s) => ({
        email: s.email,
        role: s.role,
        status: s.status,
        awayReason: s.awayReason,
        schedule: s.schedule,
        ringPriority: s.ringPriority,
        lastHeartbeatAt: s.lastHeartbeatAt,
        hasPassword: hasPassword.get(s.email) ?? false,
      }))
  );
}

export async function handlePutStaffSchedule(request: Request, db: D1Database, email: string, staff: StaffUser): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (!isBusinessHoursSchedule(body)) return new Response("invalid request body", { status: 400 });
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
  await invalidateTokensForEmail(env.DB, email);
  await clearAttempts(env.DB, email);
  // Their HANDSET, not just their login. getPushTokensForType selects every row in push_tokens and
  // filters only on the owner having switched that notification type off -- it never checks the
  // owner still exists. Leaving these behind means a removed person's phone keeps showing inbound
  // customer texts, sender name and all, indefinitely, with nothing anywhere saying so.
  await env.DB.prepare("DELETE FROM push_tokens WHERE staff_email = ?").bind(email).run();
  // And their per-user settings, so a re-invite starts clean rather than silently restoring the
  // old mobile number and ring-my-mobile state onto a new person at the same address.
  await env.DB.prepare("DELETE FROM user_settings WHERE email = ?").bind(email).run();
  await deleteStaff(env.DB, email);
  return jsonResponse({ ok: true });
}

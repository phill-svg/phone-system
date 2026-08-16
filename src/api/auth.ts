// src/api/auth.ts
import { verifyPassword, getDummyHash, hashPassword } from "../access/password";
import { createSession, destroySession, destroySessionsForEmail, parseSessionCookie, sessionCookieHeader, clearSessionCookieHeader, parseBearerToken } from "../access/session";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "../access/loginAttempts";
import { issueToken, peekToken, consumeToken } from "../access/passwordTokens";
import { sendEmail, resetEmail } from "../email/sendgrid";
import { renderLoginPage, renderForgotPasswordPage, renderSetPasswordPage, renderAuthMessagePage } from "../html/pages/login";
import { jsonResponse } from "./respond";

type Env = {
  DB: D1Database;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  SENDGRID_API_KEY?: string;
  AUTH_FROM_EMAIL?: string;
};

function html(body: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...(extraHeaders ?? {}) } });
}

export async function handleLoginPage(_request: Request, _env: Env): Promise<Response> {
  return html(renderLoginPage());
}

export async function handleLoginSubmit(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");

  if (!email || !password) {
    return html(renderLoginPage({ error: "Enter your email and password.", email }), 400);
  }

  if (await isRateLimited(env.DB, email)) {
    return html(renderLoginPage({ error: "Too many attempts. Try again in a few minutes.", email }), 429);
  }

  const user = await env.DB.prepare("SELECT email, password_hash FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; password_hash: string | null }>();

  // Unknown email or password not set yet: burn equivalent time, then fail generically.
  if (!user || !user.password_hash) {
    await verifyPassword(password, await getDummyHash());
    await recordFailedAttempt(env.DB, email);
    return html(renderLoginPage({ error: "Invalid email or password.", email }), 401);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    await recordFailedAttempt(env.DB, email);
    return html(renderLoginPage({ error: "Invalid email or password.", email }), 401);
  }

  await clearAttempts(env.DB, email);
  const token = await createSession(env.DB, user.email);
  return new Response(null, {
    status: 302,
    headers: { Location: "/admin/live", "Set-Cookie": sessionCookieHeader(token) },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = parseSessionCookie(request);
  if (token) await destroySession(env.DB, token);
  return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": clearSessionCookieHeader() } });
}

export async function handleForgotPasswordPage(_request: Request, _env: Env): Promise<Response> {
  return html(renderForgotPasswordPage());
}

export async function handleForgotPasswordSubmit(request: Request, env: Env, origin: string): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // Neutral response regardless of existence. Only send if the account actually exists.
  if (email) {
    const user = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(email).first<{ email: string }>();
    if (user) {
      try {
        const token = await issueToken(env.DB, user.email, "reset");
        const link = `${origin}/set-password?token=${token}`;
        const { subject, html: body } = resetEmail(link);
        await sendEmail(env, { to: user.email, subject, html: body });
      } catch {
        // Swallow: never reveal existence or transport errors on this endpoint.
      }
    }
  }
  return html(renderForgotPasswordPage({ done: true }));
}

export async function handleSetPasswordPage(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const info = token ? await peekToken(env.DB, token) : null;
  if (!info) {
    return html(renderAuthMessagePage({ title: "Link expired", message: "This password link is invalid or has expired. Request a new one." }), 400);
  }
  return html(renderSetPasswordPage({ token, email: info.email }));
}

export async function handleSetPasswordSubmit(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  const info = token ? await peekToken(env.DB, token) : null;
  if (!info) {
    return html(renderAuthMessagePage({ title: "Link expired", message: "This password link is invalid or has expired. Request a new one." }), 400);
  }
  if (password.length < 10) {
    return html(renderSetPasswordPage({ token, email: info.email, error: "Password must be at least 10 characters." }), 400);
  }
  if (password !== confirm) {
    return html(renderSetPasswordPage({ token, email: info.email, error: "Passwords do not match." }), 400);
  }

  const consumed = await consumeToken(env.DB, token);
  if (!consumed) {
    return html(renderAuthMessagePage({ title: "Link expired", message: "This password link is invalid or has expired. Request a new one." }), 400);
  }

  const hash = await hashPassword(password);
  await env.DB.prepare("UPDATE staff_users SET password_hash = ?, password_set_at = ? WHERE email = ?")
    .bind(hash, Date.now(), consumed.email)
    .run();
  // Defense in depth: a reset invalidates any existing sessions.
  await destroySessionsForEmail(env.DB, consumed.email);

  const session = await createSession(env.DB, consumed.email);
  return new Response(null, { status: 302, headers: { Location: "/admin/live", "Set-Cookie": sessionCookieHeader(session) } });
}

export async function handleApiLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return jsonResponse({ error: "Enter your email and password." }, 400);

  if (await isRateLimited(env.DB, email)) {
    return jsonResponse({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const user = await env.DB.prepare("SELECT email, role, password_hash FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff"; password_hash: string | null }>();

  if (!user || !user.password_hash) {
    await verifyPassword(password, await getDummyHash());
    await recordFailedAttempt(env.DB, email);
    return jsonResponse({ error: "Invalid email or password." }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await recordFailedAttempt(env.DB, email);
    return jsonResponse({ error: "Invalid email or password." }, 401);
  }

  await clearAttempts(env.DB, email);
  const token = await createSession(env.DB, user.email);
  return jsonResponse({ token, user: { email: user.email, role: user.role } });
}

export async function handleApiLogout(request: Request, env: Env): Promise<Response> {
  const token = parseSessionCookie(request) ?? parseBearerToken(request);
  if (token) await destroySession(env.DB, token);
  return jsonResponse({ ok: true });
}

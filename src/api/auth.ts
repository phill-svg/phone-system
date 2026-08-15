// src/api/auth.ts
import { verifyPassword, getDummyHash } from "../access/password";
import { createSession, destroySession, parseSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from "../access/session";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "../access/loginAttempts";
import { renderLoginPage } from "../html/pages/login";

type Env = { DB: D1Database; AUTH_MODE?: string; DEV_STAFF_EMAIL?: string };

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

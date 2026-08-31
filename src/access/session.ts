import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "tcb_session";
// Staff stay signed in until they actively log out. This is a phone the team leaves running all
// day on a tablet, a desktop tray app and their own mobiles; a timed expiry just meant being
// silently logged out mid-shift and missing calls. Sessions still end immediately on logout, and
// destroySessionsForEmail() still revokes every session on a password reset or when an account is
// removed -- so the deliberate ways out are unchanged, only the clock is gone.
//
// The row still carries an expires_at because the column is NOT NULL and the sweep below reads it;
// ten years is "never" for this purpose without needing a schema change.
const SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export async function createSession(db: D1Database, email: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, email, now, now + SESSION_TTL_MS)
    .run();
  // Best-effort sweep of expired rows; cheap and keeps the table small.
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return token;
}

export async function lookupSession(db: D1Database, token: string): Promise<string | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT email, expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ email: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return row.email;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function destroySessionsForEmail(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run();
}

export function parseSessionCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE) return trimmed.slice(eq + 1) || null;
  }
  return null;
}

export function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1].trim() || null) : null;
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

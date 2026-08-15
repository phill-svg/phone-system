import { randomToken, sha256Hex } from "./crypto";

export type TokenPurpose = "invite" | "reset";

const TTL_MS: Record<TokenPurpose, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

export async function issueToken(db: D1Database, email: string, purpose: TokenPurpose): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await db
    .prepare("INSERT INTO password_tokens (token_hash, email, purpose, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
    .bind(tokenHash, email, purpose, now, now + TTL_MS[purpose])
    .run();
  return token;
}

async function readValid(db: D1Database, token: string) {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT email, purpose, expires_at, used_at FROM password_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ email: string; purpose: TokenPurpose; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at !== null || row.expires_at < Date.now()) return null;
  return { tokenHash, email: row.email, purpose: row.purpose };
}

export async function peekToken(db: D1Database, token: string): Promise<{ email: string; purpose: TokenPurpose } | null> {
  const r = await readValid(db, token);
  return r ? { email: r.email, purpose: r.purpose } : null;
}

export async function consumeToken(db: D1Database, token: string): Promise<{ email: string; purpose: TokenPurpose } | null> {
  const r = await readValid(db, token);
  if (!r) return null;
  const res = await db
    .prepare("UPDATE password_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(Date.now(), r.tokenHash)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null; // lost a race; treat as consumed
  return { email: r.email, purpose: r.purpose };
}

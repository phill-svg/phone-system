// Expo push tokens registered by staff devices. Used to notify staff of inbound SMS.

import type { NotifKey } from "./userSettings";

export async function upsertPushToken(
  db: D1Database,
  t: { token: string; platform: string; staffEmail: string | null; now: number }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, staff_email = excluded.staff_email, last_seen = excluded.last_seen`
    )
    .bind(t.token, t.platform, t.staffEmail, t.now, t.now)
    .run();
}

export async function listPushTokens(db: D1Database): Promise<string[]> {
  const rows = await db.prepare("SELECT token FROM push_tokens").all<{ token: string }>();
  return rows.results.map((r) => r.token);
}

export async function deletePushTokens(db: D1Database, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  const placeholders = tokens.map(() => "?").join(",");
  await db.prepare(`DELETE FROM push_tokens WHERE token IN (${placeholders})`).bind(...tokens).run();
}

// Tokens to notify for a given push type. A token is included when its owner has NOT disabled that
// type (default is on) — and tokens with no known owner are always included. `value = 'false'` is the
// JSON encoding a disabled boolean is stored as (see userSettings).
export async function getPushTokensForType(db: D1Database, key: NotifKey): Promise<string[]> {
  const tokens = await db
    .prepare("SELECT token, staff_email FROM push_tokens")
    .all<{ token: string; staff_email: string | null }>();
  const disabled = await db
    .prepare("SELECT email FROM user_settings WHERE key = ? AND value = 'false'")
    .bind(key)
    .all<{ email: string }>();
  const disabledSet = new Set(disabled.results.map((r) => r.email));
  return tokens.results
    .filter((r) => !r.staff_email || !disabledSet.has(r.staff_email))
    .map((r) => r.token);
}

// Expo push tokens registered by staff devices. Used to notify staff of inbound SMS.

import { blankToNull } from "./calls";
import type { NotifKey } from "./userSettings";

export async function upsertPushToken(
  db: D1Database,
  t: {
    token: string;
    platform: string;
    staffEmail: string | null;
    now: number;
    // What the handset is running. `nativeBuild` is the identity of the installed BINARY, which is
    // the only thing that says whether a native fix (the CallKit patch above all) is on that phone
    // -- an OTA reaches every binary on the same runtimeVersion, so otaBuild cannot answer it.
    otaBuild?: string | null;
    nativeBuild?: string | null;
    // sha256 of the session token that registered it (sessions.token_hash). Overwritten, never
    // COALESCEd: a new session registering this token is exactly the rebinding that has to win.
    sessionHash?: string | null;
  }
): Promise<void> {
  // COALESCE, so a client that does not send them -- an older handset, or one whose
  // Application.nativeBuildVersion is genuinely null -- never blanks a build we already recorded.
  // Same rule as the recording-status callback: a write must not erase what an earlier one knew,
  // and `blankToNull` is the same helper that rule already uses -- "" is a VALUE that survives
  // COALESCE and blanks the column just as destructively as NULL would have.
  await db
    .prepare(
      `INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen, ota_build, native_build, session_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         platform = excluded.platform,
         staff_email = excluded.staff_email,
         last_seen = excluded.last_seen,
         session_hash = excluded.session_hash,
         ota_build = COALESCE(excluded.ota_build, push_tokens.ota_build),
         native_build = COALESCE(excluded.native_build, push_tokens.native_build)`
    )
    .bind(t.token, t.platform, t.staffEmail, t.now, t.now, blankToNull(t.otaBuild), blankToNull(t.nativeBuild), t.sessionHash ?? null)
    .run();
}

export async function deletePushTokens(db: D1Database, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  const placeholders = tokens.map(() => "?").join(",");
  await db.prepare(`DELETE FROM push_tokens WHERE token IN (${placeholders})`).bind(...tokens).run();
}

// Tokens to notify for a given push type. A token is included when its owner has NOT disabled that
// type (default is on) — and tokens with no known owner are always included. `value = 'false'` is the
// JSON encoding a disabled boolean is stored as (see userSettings).
// The push_tokens rows that may still be pushed to, as a FROM clause aliased `p`: the session that
// registered the token still exists. Logout, a password reset and staff removal all delete sessions,
// so each of them stops the pushes. A NULL session_hash predates migration 0039 and still receives
// until that handset re-registers; 0039 deleted the NULL rows whose owner had no session left.
// EVERY reader that sends, or reports what would be sent, uses this -- Health Checks and Test Push
// included, or they call a phone fine that real pushes skip.
export const LIVE_PUSH_TOKENS =
  "push_tokens p LEFT JOIN sessions s ON s.token_hash = p.session_hash WHERE (p.session_hash IS NULL OR s.token_hash IS NOT NULL)";

export async function getPushTokensForType(db: D1Database, key: NotifKey): Promise<string[]> {
  const tokens = await db
    .prepare(`SELECT p.token, p.staff_email FROM ${LIVE_PUSH_TOKENS}`)
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

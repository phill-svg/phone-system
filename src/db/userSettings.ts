// Per-user preferences, merged over typed defaults. Stored one row per (email, key) with the value
// JSON-encoded, so new keys are additive and reads always return a complete, typed object.

export type UserSettings = {
  notif_incoming: boolean;
  notif_missed: boolean;
  notif_voicemail: boolean;
  notif_sms: boolean;
  ring_my_mobile: boolean;
  mobile_number: string;
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  notif_incoming: true,
  notif_missed: true,
  notif_voicemail: true,
  notif_sms: true,
  ring_my_mobile: false,
  mobile_number: "",
};

export const NOTIF_KEYS = ["notif_incoming", "notif_missed", "notif_voicemail", "notif_sms"] as const;
export type NotifKey = (typeof NOTIF_KEYS)[number];

// Validate a stored/incoming value against the default's type. Wrong-typed values are dropped so a
// corrupt row can never widen the type.
function coerce<K extends keyof UserSettings>(key: K, value: unknown): UserSettings[K] | undefined {
  const expected = typeof DEFAULT_USER_SETTINGS[key];
  return typeof value === expected ? (value as UserSettings[K]) : undefined;
}

const KNOWN_KEYS = Object.keys(DEFAULT_USER_SETTINGS) as (keyof UserSettings)[];

export async function getUserSettings(db: D1Database, email: string): Promise<UserSettings> {
  const rows = await db
    .prepare("SELECT key, value FROM user_settings WHERE email = ?")
    .bind(email.toLowerCase())
    .all<{ key: string; value: string }>();
  const result: UserSettings = { ...DEFAULT_USER_SETTINGS };
  for (const row of rows.results) {
    if (!KNOWN_KEYS.includes(row.key as keyof UserSettings)) continue;
    const key = row.key as keyof UserSettings;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const value = coerce(key, parsed);
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export async function setUserSettings(
  db: D1Database,
  email: string,
  partial: Partial<UserSettings>
): Promise<UserSettings> {
  const now = Date.now();
  const lower = email.toLowerCase();
  const stmts: D1PreparedStatement[] = [];
  for (const key of KNOWN_KEYS) {
    if (!(key in partial)) continue;
    const value = coerce(key, partial[key]);
    if (value === undefined) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO user_settings (email, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(email, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(lower, key, JSON.stringify(value), now)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return getUserSettings(db, lower);
}

// Normalize an AU mobile to E.164 (+61…). Accepts "04xxxxxxxx", "+61…", "61…", with spaces.
// Returns null if it isn't a plausible AU mobile (must yield +614xxxxxxxx, 12 chars after +61 = 9 digits).
export function normalizeMobileE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  let e164: string | null = null;
  if (/^\+61\d{9}$/.test(digits)) e164 = digits;
  else if (/^61\d{9}$/.test(digits)) e164 = `+${digits}`;
  else if (/^0\d{9}$/.test(digits)) e164 = `+61${digits.slice(1)}`;
  if (!e164) return null;
  return /^\+614\d{8}$/.test(e164) ? e164 : null; // AU mobiles are +614xxxxxxxx
}

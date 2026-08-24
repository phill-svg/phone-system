// The business's sending numbers — what the user can pick as the caller-ID (voice) or "from" (SMS).
// Seeded in migration 0020; ported/real numbers get inserted here and show up in the pickers.

export type PhoneNumber = {
  id: number;
  e164: string;
  label: string;
  voice_enabled: number;
  sms_enabled: number;
  is_default_voice: number;
  is_default_sms: number;
  region: string | null;
};

export type PhoneNumberInput = {
  e164: string;
  label: string;
  voice_enabled: boolean;
  sms_enabled: boolean;
  is_default_voice: boolean;
  is_default_sms: boolean;
  region: string | null;
};

export async function createPhoneNumber(db: D1Database, input: PhoneNumberInput): Promise<PhoneNumber> {
  // Only one default per channel: clear the flag on every other row, AND insert, in ONE atomic
  // batch (D1 batches run in a transaction). Doing the clears separately meant a failed insert
  // (e.g. duplicate e164) left the table with every default already wiped and no replacement set.
  const stmts: D1PreparedStatement[] = [];
  if (input.is_default_voice) stmts.push(db.prepare("UPDATE phone_numbers SET is_default_voice = 0"));
  if (input.is_default_sms) stmts.push(db.prepare("UPDATE phone_numbers SET is_default_sms = 0"));
  stmts.push(
    db
      .prepare(
        "INSERT INTO phone_numbers (e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region"
      )
      .bind(
        input.e164.trim(),
        input.label.trim(),
        input.voice_enabled ? 1 : 0,
        input.sms_enabled ? 1 : 0,
        input.is_default_voice ? 1 : 0,
        input.is_default_sms ? 1 : 0,
        input.region,
        Date.now()
      )
  );
  const results = await db.batch<PhoneNumber>(stmts);
  return results[results.length - 1].results[0];
}

export async function updatePhoneNumber(db: D1Database, id: number, input: PhoneNumberInput): Promise<boolean> {
  const stmts: D1PreparedStatement[] = [];
  if (input.is_default_voice) stmts.push(db.prepare("UPDATE phone_numbers SET is_default_voice = 0"));
  if (input.is_default_sms) stmts.push(db.prepare("UPDATE phone_numbers SET is_default_sms = 0"));
  stmts.push(
    db
      .prepare(
        "UPDATE phone_numbers SET label = ?, voice_enabled = ?, sms_enabled = ?, is_default_voice = ?, is_default_sms = ?, region = ? WHERE id = ?"
      )
      .bind(
        input.label.trim(),
        input.voice_enabled ? 1 : 0,
        input.sms_enabled ? 1 : 0,
        input.is_default_voice ? 1 : 0,
        input.is_default_sms ? 1 : 0,
        input.region,
        id
      )
  );
  const res = await db.batch(stmts);
  const last = res[res.length - 1];
  return (last.meta.changes ?? 0) > 0;
}

export async function deletePhoneNumber(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM phone_numbers WHERE id = ?").bind(id).run();
}

export async function listPhoneNumbers(db: D1Database): Promise<PhoneNumber[]> {
  const r = await db
    .prepare(
      "SELECT id, e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region FROM phone_numbers ORDER BY id ASC"
    )
    .all<PhoneNumber>();
  return r.results;
}

// Resolve the "from"/caller-ID to actually use for a channel. If the client asked for a specific
// number, it's honoured ONLY if it's an enabled sending number for that channel (prevents spoofing
// an arbitrary caller-ID); otherwise we fall back to the channel default, then any enabled number.
// Returns null if the DB has no enabled number for the channel (caller then uses the env fallback).
export async function resolveSendingNumber(
  db: D1Database,
  channel: "voice" | "sms",
  requested: string | null
): Promise<string | null> {
  const nums = await listPhoneNumbers(db);
  const enabled = nums.filter((n) => (channel === "voice" ? n.voice_enabled : n.sms_enabled));
  if (enabled.length === 0) return null;
  if (requested) {
    const match = enabled.find((n) => n.e164 === requested);
    if (match) return match.e164;
  }
  const def = enabled.find((n) => (channel === "voice" ? n.is_default_voice : n.is_default_sms));
  return (def ?? enabled[0]).e164;
}

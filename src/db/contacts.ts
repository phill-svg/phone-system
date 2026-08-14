export type Contact = {
  id: number;
  name: string;
  company: string | null;
  phone: string;
  phone_normalized: string;
  created_at: number;
  updated_at: number;
};

export type ContactInput = {
  name: string;
  phone: string;
  company?: string | null;
};

// Normalize a phone number to a digits-only canonical form for matching, tuned for Australian
// numbers. The SAME algorithm runs client-side in phone.ts (resolving call numbers to contacts),
// so keep the two in lock-step:
//   "+61 400 123 456" -> "61400123456"
//   "0400 123 456"    -> "61400123456"  (leading 0 is the AU national trunk prefix)
//   "(02) 8395 3312"  -> "61283953312"
// A leading "+" is treated as already-international. Anything else is returned as bare digits.
export function normalizePhone(raw: string): string {
  if (!raw) return "";
  const hasPlus = raw.trim().charAt(0) === "+";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return digits;
  if (digits.charAt(0) === "0") return "61" + digits.slice(1);
  return digits;
}

export async function listContacts(db: D1Database): Promise<Contact[]> {
  const result = await db
    .prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE ASC")
    .all<Contact>();
  return result.results;
}

export async function createContact(db: D1Database, input: ContactInput): Promise<Contact> {
  const now = Date.now();
  const normalized = normalizePhone(input.phone);
  const company = input.company?.trim() || null;
  const result = await db
    .prepare(
      "INSERT INTO contacts (name, company, phone, phone_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .bind(input.name.trim(), company, input.phone.trim(), normalized, now, now)
    .first<Contact>();
  return result as Contact;
}

export async function updateContact(
  db: D1Database,
  id: number,
  input: ContactInput
): Promise<boolean> {
  const normalized = normalizePhone(input.phone);
  const company = input.company?.trim() || null;
  const result = await db
    .prepare(
      "UPDATE contacts SET name = ?, company = ?, phone = ?, phone_normalized = ?, updated_at = ? WHERE id = ?"
    )
    .bind(input.name.trim(), company, input.phone.trim(), normalized, Date.now(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteContact(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM contacts WHERE id = ?").bind(id).run();
}

// Bulk import (CSV upload path). Upserts by normalized phone number: a row whose number already
// exists updates that contact's name/company/formatting rather than creating a duplicate. Rows
// missing a name or a usable phone number are skipped.
export async function importContacts(
  db: D1Database,
  rows: ContactInput[]
): Promise<{ imported: number; updated: number; skipped: number }> {
  const now = Date.now();
  const existing = await db
    .prepare("SELECT id, phone_normalized FROM contacts")
    .all<{ id: number; phone_normalized: string }>();
  const idByNorm = new Map<string, number>();
  for (const row of existing.results) {
    if (!idByNorm.has(row.phone_normalized)) idByNorm.set(row.phone_normalized, row.id);
  }

  const statements: D1PreparedStatement[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const name = (row.name ?? "").trim();
    const phone = (row.phone ?? "").trim();
    const normalized = normalizePhone(phone);
    if (!name || !normalized) {
      skipped++;
      continue;
    }
    const company = (row.company ?? "").trim() || null;
    const existingId = idByNorm.get(normalized);
    if (existingId && existingId > 0) {
      statements.push(
        db
          .prepare("UPDATE contacts SET name = ?, company = ?, phone = ?, updated_at = ? WHERE id = ?")
          .bind(name, company, phone, now, existingId)
      );
      updated++;
    } else if (existingId === undefined) {
      statements.push(
        db
          .prepare(
            "INSERT INTO contacts (name, company, phone, phone_normalized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(name, company, phone, normalized, now, now)
      );
      // Guard against duplicate inserts for the same number within this one import batch.
      idByNorm.set(normalized, -1);
      imported++;
    } else {
      // Number already claimed earlier in this same batch -- treat as a skip, not a second insert.
      skipped++;
    }
  }

  if (statements.length) await db.batch(statements);
  return { imported, updated, skipped };
}

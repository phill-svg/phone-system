import { normalizePhone } from "../db/contacts";
import { resolveCustomerName, searchByPhone } from "../servicem8/client";
import { jsonResponse } from "./respond";

// Admin > Sync contacts. Every number that has called or texted and has no saved contact is looked
// up in ServiceM8; the matches go back to an admin to tick, and only the ticked ones are saved.
// This is the manual counterpart of the after-call sync (src/servicem8/), which only ever sees
// calls, only from the day it shipped, and never texts.

// Numbers checked per request. On Workers Free a request may make 50 outside fetches, and each
// number costs a search plus, when the search carries no name, a job-contact lookup: 15 keeps the
// worst case at 30. The client asks again with `after` until `next` is null.
export const CONTACT_LOOKUP_BATCH = 15;

// One save cannot be unbounded; 500 is far beyond the ~40 unsaved numbers there are today. It is a
// single query whatever the size, so this bounds the request body, not the query count.
const MAX_SAVE = 500;

type BusinessNumbers = { TWILIO_FROM_NUMBER?: string; TWILIO_SMS_NUMBER?: string };

export type UnsavedNumber = { phone: string; lastSeen: number };

// Every customer number (E.164, so Messenger senders and withheld callers drop out) seen on a call
// or a text that is not deleted, is not one of the business's own numbers, and has no saved
// contact. Outbound calls store the BUSINESS number in caller_number, so the customer there is
// called_number. Ordered by number so `after` is a stable cursor.
export async function listUnsavedNumbers(db: D1Database, env: BusinessNumbers): Promise<UnsavedNumber[]> {
  const rows = await db
    .prepare(
      `WITH seen AS (
         SELECT CASE WHEN direction = 'outbound' THEN called_number ELSE caller_number END AS phone, started_at AS ts
           FROM calls WHERE deleted_at IS NULL
         UNION ALL
         SELECT peer_number, created_at FROM messages WHERE deleted_at IS NULL
       )
       SELECT phone, MAX(ts) AS lastSeen FROM seen
        WHERE phone LIKE '+%'
          AND phone NOT IN (SELECT e164 FROM phone_numbers)
          AND phone NOT IN (?, ?)
          AND substr(phone, 2) NOT IN (SELECT phone_normalized FROM contacts)
        GROUP BY phone
        ORDER BY phone`
    )
    .bind(env.TWILIO_FROM_NUMBER ?? "", env.TWILIO_SMS_NUMBER ?? "")
    .all<UnsavedNumber>();
  // A staff member's own mobile is in `calls` whenever they ring the landline (a test call, or
  // ring-my-mobile's own legs), and saved under a customer's name it would label every call and
  // text from that staff member as the customer. Stored as typed, so compared normalised.
  const staff = await staffMobiles(db);
  return rows.results.filter((r) => !staff.has(normalizePhone(r.phone)));
}

async function staffMobiles(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT value FROM user_settings WHERE key = 'mobile_number'").all<{ value: string }>();
  const out = new Set<string>();
  for (const { value } of rows.results) {
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      continue;
    }
    const normalized = typeof raw === "string" ? normalizePhone(raw) : "";
    if (normalized) out.add(normalized);
  }
  return out;
}

type LookupEnv = BusinessNumbers & { DB: D1Database; SERVICEM8_API_KEY?: string };

export async function handleServiceM8ContactLookup(request: Request, env: LookupEnv): Promise<Response> {
  if (!env.SERVICEM8_API_KEY) {
    return jsonResponse({ error: "ServiceM8 isn't connected: the SERVICEM8_API_KEY secret is not set." }, 503);
  }
  const body = (await request.json().catch(() => null)) as { after?: unknown } | null;
  const after = typeof body?.after === "string" ? body.after : "";

  const unsaved = await listUnsavedNumbers(env.DB, env);
  const pending = unsaved.filter((n) => n.phone > after);
  const batch = pending.slice(0, CONTACT_LOOKUP_BATCH);

  const matches: Array<{ phone: string; name: string; lastSeen: number }> = [];
  let failed = 0;
  let lastError = "";
  // One at a time: ServiceM8 is a small business's account, not a bulk API, and a burst of
  // parallel searches is the kind of thing that gets a key rate-limited.
  for (const n of batch) {
    let results;
    try {
      results = await searchByPhone(env.SERVICEM8_API_KEY, n.phone);
    } catch (e) {
      failed++;
      lastError = String(e);
      console.error("SERVICEM8_CONTACT_LOOKUP_FAILED", JSON.stringify({ number: n.phone, error: lastError }));
      continue;
    }
    if (results.length === 0) continue;
    // The search worked; a refused job-contact fallback means "no name", not a failed search.
    let name: string | null = null;
    try {
      name = await resolveCustomerName(env.SERVICEM8_API_KEY, results, n.phone);
    } catch (e) {
      console.error("SERVICEM8_CONTACT_NAME_FAILED", JSON.stringify({ number: n.phone, error: String(e) }));
    }
    if (name) matches.push({ phone: n.phone, name, lastSeen: n.lastSeen });
  }

  // The FIRST page refused outright is a key or an outage, never "nobody is a customer": say so.
  // On a later page the run already holds matches, so a failure there is counted, not fatal.
  if (!after && batch.length > 0 && failed === batch.length) {
    // The status only: ServiceM8's own error body (an HTML page in an outage) is in the log line.
    const status = /failed: (\d{3})/.exec(lastError)?.[1];
    const hint = status === "401" || status === "403" ? "Check the ServiceM8 API key." : "Try again later.";
    return jsonResponse({ error: `ServiceM8 refused the search${status ? ` (status ${status})` : ""}. ${hint}` }, 502);
  }

  const remaining = pending.length - batch.length;
  return jsonResponse({
    matches,
    checked: batch.length,
    failed,
    total: unsaved.length,
    remaining,
    next: remaining > 0 ? batch[batch.length - 1].phone : null,
  });
}

// Saves the ticked matches. Never overwrites: someone may have saved that number by hand while the
// list was open, and their name wins. Validated whole before anything is written.
export async function handleServiceM8ContactSave(request: Request, db: D1Database): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { contacts?: unknown } | null;
  if (!body || !Array.isArray(body.contacts)) return jsonResponse({ error: "contacts array is required" }, 400);
  if (body.contacts.length > MAX_SAVE) return jsonResponse({ error: `too many contacts in one save (max ${MAX_SAVE})` }, 400);

  const rows: Array<{ name: string; phone: string; normalized: string }> = [];
  for (const entry of body.contacts as Array<{ name?: unknown; phone?: unknown }>) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const phone = typeof entry?.phone === "string" ? entry.phone.trim() : "";
    const normalized = normalizePhone(phone);
    if (!name || !normalized) {
      return jsonResponse({ error: `invalid contact: "${name || "(no name)"}" / "${phone || "(no number)"}"` }, 400);
    }
    rows.push({ name, phone, normalized });
  }

  // A number ticked twice is saved once, under its first entry. One INSERT ... SELECT cannot see
  // its own earlier rows, so the NOT EXISTS below would not catch the repeat.
  const seen = new Set<string>();
  const firstWins = rows.filter((r) => !seen.has(r.normalized) && seen.add(r.normalized));
  const now = Date.now();
  // ONE query however many were ticked: the rows travel as a single JSON parameter, and the
  // NOT EXISTS skips any number already saved (by hand while the list was open, say) rather than
  // overwriting it. D1 caps the queries per request on the free plan, so a statement per contact
  // would put a ceiling on how many could be saved at once.
  const result = await db
    .prepare(
      `INSERT INTO contacts (name, company, phone, phone_normalized, created_at, updated_at)
       SELECT json_extract(j.value, '$.name'), NULL, json_extract(j.value, '$.phone'), json_extract(j.value, '$.normalized'), ?, ?
         FROM json_each(?) AS j
        WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.phone_normalized = json_extract(j.value, '$.normalized'))`
    )
    .bind(now, now, JSON.stringify(firstWins))
    .run();
  const saved = result.meta.changes ?? 0;
  console.log("SERVICEM8_CONTACTS_SAVED", JSON.stringify({ saved, skipped: rows.length - saved }));
  return jsonResponse({ saved, skipped: rows.length - saved });
}

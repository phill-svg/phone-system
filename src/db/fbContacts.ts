// Cached Facebook Messenger sender names, keyed by PSID. Resolved via the Graph API (see
// ../facebook/graph.ts) the first time we see a given sender, then reused so we don't re-fetch
// on every inbound message.

export async function getFacebookName(db: D1Database, psid: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM fb_contacts WHERE psid = ?").bind(psid).first<{ name: string }>();
  return row?.name ?? null;
}

export async function upsertFacebookName(db: D1Database, psid: string, name: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO fb_contacts (psid, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(psid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at"
    )
    .bind(psid, name, Date.now())
    .run();
}

// PSIDs we have Messenger conversations with but no cached name for — the backlog the dashboard's
// manual refresh retries. A name is only ever fetched when an inbound message arrives, so every
// sender whose lookup failed (an expired token, say) stays nameless until something asks again.
export async function listUnnamedFacebookPsids(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT substr(m.peer_number, length('messenger:') + 1) AS psid
         FROM messages m
        WHERE m.peer_number LIKE 'messenger:%'
          AND NOT EXISTS (SELECT 1 FROM fb_contacts fb WHERE fb.psid = substr(m.peer_number, length('messenger:') + 1))
        ORDER BY psid`
    )
    .all<{ psid: string }>();
  return rows.results.map((r) => r.psid);
}

// Diagnostics for a Messenger sender we still can't name. Records WHICH fields Twilio's webhook
// carried (names only, never values) without touching the retry budget, so it is possible to tell
// "Twilio never sends us a name, the Graph API is the only route" apart from "we never looked".
export async function noteTwilioMessengerFields(db: D1Database, psid: string, fields: string[]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fb_name_attempts (psid, attempts, last_attempt_at, last_error) VALUES (?, 0, 0, ?)
       ON CONFLICT(psid) DO UPDATE SET last_error = excluded.last_error`
    )
    .bind(psid, `no name field from Twilio; webhook sent: ${fields.slice().sort().join(",")}`)
    .run();
}

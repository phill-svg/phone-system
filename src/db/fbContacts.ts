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

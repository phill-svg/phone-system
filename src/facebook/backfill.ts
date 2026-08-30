import { lookupFacebookName } from "./graph";
import { fetchPageInboxNames } from "./pageInbox";
import { upsertFacebookName } from "../db/fbContacts";

// Cron sweep that fills in Messenger sender names the one-shot lookup on their first message
// missed. Mirrors the transcript backfill: bounded per tick, attempt-capped so it drains.

// A psid the Page token simply cannot read never becomes readable, so stop asking. Twelve tries
// spaced 30 minutes apart covers roughly six hours -- long enough to ride out a Graph outage or a
// token being replaced, short enough not to hammer Facebook forever.
export const MAX_NAME_ATTEMPTS = 12;
export const RETRY_AFTER_MS = 30 * 60 * 1000;

type Env = { DB: D1Database; FB_PAGE_ACCESS_TOKEN?: string; TWILIO_MESSENGER_FROM?: string };

export async function backfillFacebookNames(env: Env, limit = 5, now = Date.now()): Promise<number> {
  const token = env.FB_PAGE_ACCESS_TOKEN;
  if (!token) return 0;

  // Messenger peers with no cached name, that are not attempt-exhausted and are due another try.
  const rows = (
    await env.DB.prepare(
      `SELECT DISTINCT substr(m.peer_number, length('messenger:') + 1) AS psid
         FROM messages m
         LEFT JOIN fb_contacts fb ON fb.psid = substr(m.peer_number, length('messenger:') + 1)
         LEFT JOIN fb_name_attempts a ON a.psid = substr(m.peer_number, length('messenger:') + 1)
        WHERE m.peer_number LIKE 'messenger:%'
          AND fb.psid IS NULL
          AND COALESCE(a.attempts, 0) < ?
          AND COALESCE(a.last_attempt_at, 0) <= ?
        ORDER BY psid
        LIMIT ?`
    )
      .bind(MAX_NAME_ATTEMPTS, now - RETRY_AFTER_MS, limit)
      .all<{ psid: string }>()
  ).results;
  if (rows.length === 0) return 0;

  // The Page inbox names every open thread in one call, and it is the only route that works for
  // ordinary customers: the per-psid profile lookup below is refused (code 100) for anyone without
  // a role on the Page. Try it first, and only fall back to the per-psid call for whoever is left
  // (someone whose thread has aged out of the inbox listing).
  const pageId = (env.TWILIO_MESSENGER_FROM ?? "").replace(/^messenger:/, "");
  const wanted = new Set(rows.map((r) => r.psid));
  let resolved = 0;
  const inbox = await fetchPageInboxNames(pageId, token);
  if ("names" in inbox) {
    for (const [psid, name] of inbox.names) {
      if (!wanted.has(psid)) continue; // never overwrite a name already cached or typed by hand
      await upsertFacebookName(env.DB, psid, name);
      await env.DB.prepare("DELETE FROM fb_name_attempts WHERE psid = ?").bind(psid).run();
      wanted.delete(psid);
      resolved++;
    }
  } else {
    console.warn(`Facebook Page inbox lookup failed: ${inbox.error}`);
  }

  for (const psid of wanted) {
    const result = await lookupFacebookName(psid, token);
    if ("name" in result) {
      await upsertFacebookName(env.DB, psid, result.name);
      // The name is cached now; the bookkeeping row has done its job.
      await env.DB.prepare("DELETE FROM fb_name_attempts WHERE psid = ?").bind(psid).run();
      resolved++;
    } else {
      await env.DB.prepare(
        `INSERT INTO fb_name_attempts (psid, attempts, last_attempt_at, last_error) VALUES (?, 1, ?, ?)
         ON CONFLICT(psid) DO UPDATE SET attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`
      )
        .bind(psid, now, result.error)
        .run();
    }
  }
  return resolved;
}

// Attachments on a message -- a customer's photo of a rat, a meter box, a job site.
//
// Twilio hands these to the inbound webhook as `NumMedia` plus `MediaUrlN`/`MediaContentTypeN`.
// Which channels actually deliver them is a Twilio-side question, not a code one: MMS is US/Canada
// only, so an Australian number never receives one, while Facebook Messenger and WhatsApp carry
// attachments through the same fields and do work here.

export type MessageMedia = { message_id: string; idx: number; content_type: string; url: string };

// What Twilio said about the attachments on one inbound message.
//
// Parsed from the raw form rather than trusting `NumMedia` alone: the count and the fields have to
// agree, and a message claiming ten attachments while carrying one must not produce nine rows
// pointing nowhere. Anything missing a url is skipped rather than stored empty -- a row that
// renders as a broken image is worse than an attachment that was never listed.
export function parseInboundMedia(params: Record<string, string>): { idx: number; content_type: string; url: string }[] {
  const claimed = Number(params.NumMedia ?? "0");
  if (!Number.isFinite(claimed) || claimed <= 0) return [];
  // Ten is Twilio's own limit per message; the cap is here so a malformed webhook cannot make this
  // loop unbounded.
  const out: { idx: number; content_type: string; url: string }[] = [];
  for (let i = 0; i < Math.min(claimed, 10); i++) {
    const url = (params[`MediaUrl${i}`] ?? "").trim();
    if (!url) continue;
    // Twilio sends the type separately; default to something a client can still decide not to
    // render rather than guessing "image/jpeg" for what might be a PDF.
    const contentType = (params[`MediaContentType${i}`] ?? "application/octet-stream").trim();
    out.push({ idx: i, content_type: contentType, url });
  }
  return out;
}

export async function insertMessageMedia(
  db: D1Database,
  messageId: string,
  media: { idx: number; content_type: string; url: string }[]
): Promise<void> {
  if (media.length === 0) return;
  // OR IGNORE, because Twilio redelivers a webhook it did not get a 200 for, and the message row
  // itself is already ON CONFLICT DO NOTHING for the same reason.
  await db.batch(
    media.map((m) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO message_media (message_id, idx, content_type, url) VALUES (?, ?, ?, ?)"
        )
        .bind(messageId, m.idx, m.content_type, m.url)
    )
  );
}

// Every attachment in one conversation, in ONE query with ONE bound parameter.
//
// NOT `WHERE message_id IN (?, ?, ...)` over the page of messages: D1 caps a query at 100 bound
// parameters, and the thread view loads a conversation with no LIMIT -- so a customer who has sent
// more than ~100 messages would throw inside the thread handler and make the conversation
// unreadable on BOTH surfaces. It would also pass every local test, because miniflare does not
// enforce that cap, and fail only in production: the same shape as the PBKDF2 iteration limit this
// repo has already been bitten by.
//
// Scoping by peer instead fetches the whole conversation's media, which is a handful of rows even
// for a long thread -- attachments are rare compared to texts.
export async function listMediaForPeer(db: D1Database, peer: string): Promise<MessageMedia[]> {
  const rows = await db
    .prepare(
      `SELECT message_id, idx, content_type, url FROM message_media
        WHERE message_id IN (SELECT id FROM messages WHERE peer_number = ? AND deleted_at IS NULL)
        ORDER BY message_id, idx`
    )
    .bind(peer)
    .all<MessageMedia>();
  return rows.results;
}

// One attachment, for the proxy that streams it. Returns null when it does not exist, which the
// route answers as a 404 rather than reaching for Twilio with a url it does not have.
export async function getMessageMedia(db: D1Database, messageId: string, idx: number): Promise<MessageMedia | null> {
  return db
    .prepare("SELECT message_id, idx, content_type, url FROM message_media WHERE message_id = ? AND idx = ?")
    .bind(messageId, idx)
    .first<MessageMedia>();
}

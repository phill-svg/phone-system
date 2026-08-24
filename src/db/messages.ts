// Storage for SMS messages. peer_number is the customer's E.164 number; conversations are grouped
// by it. The mobile app resolves a contact name for the number client-side, so `name` is null here.

export type MessageRow = { id: string; direction: "inbound" | "outbound"; body: string; ts: number; status: string | null };
export type ConversationRow = { number: string; name: string | null; last_body: string; last_ts: number; unread: number };

export async function insertMessage(
  db: D1Database,
  m: {
    id: string;
    direction: "inbound" | "outbound";
    peer_number: string;
    // The business number this message went through (Twilio "To" on inbound, "From" on outbound).
    // Null only when the caller genuinely doesn't know it.
    our_number: string | null;
    body: string;
    status: string | null;
    read: number;
    createdAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (id, direction, peer_number, our_number, body, status, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    )
    .bind(m.id, m.direction, m.peer_number, m.our_number, m.body, m.status, m.read, m.createdAt)
    .run();
}

// Latest message per conversation, newest first, with an unread (inbound, not yet viewed) count.
export async function listConversations(db: D1Database): Promise<ConversationRow[]> {
  const rows = await db
    .prepare(
      `SELECT m.peer_number AS number, m.body AS last_body, m.created_at AS last_ts,
         (SELECT COUNT(*) FROM messages u WHERE u.peer_number = m.peer_number AND u.direction = 'inbound' AND u.read = 0) AS unread
       FROM messages m
       JOIN (SELECT peer_number, MAX(created_at) AS mx FROM messages GROUP BY peer_number) latest
         ON m.peer_number = latest.peer_number AND m.created_at = latest.mx
       GROUP BY m.peer_number
       ORDER BY m.created_at DESC`
    )
    .all<{ number: string; last_body: string; last_ts: number; unread: number }>();
  return rows.results.map((r) => ({ number: r.number, name: null, last_body: r.last_body, last_ts: r.last_ts, unread: r.unread }));
}

// `limit` returns only the LAST n messages (still in ascending order) — used by the call-detail
// SMS peek, which only shows a handful and shouldn't pull a whole long-running thread out of D1.
export async function listThread(db: D1Database, peer: string, limit?: number): Promise<MessageRow[]> {
  if (limit != null) {
    const rows = await db
      .prepare(
        "SELECT * FROM (SELECT id, direction, body, created_at AS ts, status FROM messages WHERE peer_number = ? ORDER BY created_at DESC LIMIT ?) ORDER BY ts ASC"
      )
      .bind(peer, limit)
      .all<MessageRow>();
    return rows.results;
  }
  const rows = await db
    .prepare("SELECT id, direction, body, created_at AS ts, status FROM messages WHERE peer_number = ? ORDER BY created_at ASC")
    .bind(peer)
    .all<MessageRow>();
  return rows.results;
}

export async function markThreadRead(db: D1Database, peer: string): Promise<void> {
  await db.prepare("UPDATE messages SET read = 1 WHERE peer_number = ? AND direction = 'inbound'").bind(peer).run();
}

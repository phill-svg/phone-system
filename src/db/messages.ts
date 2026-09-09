// Storage for SMS messages. peer_number is the customer's E.164 number (or "messenger:<psid>" for
// Facebook Messenger); conversations are grouped by it. The mobile app resolves a contact name for
// phone numbers client-side, so `name` is null for those; Messenger peers get their cached
// Graph API name (see ../facebook/graph.ts + ./fbContacts.ts) joined in here instead.

export type MessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  ts: number;
  status: string | null;
  error_code: string | null;
  error_message: string | null;
};
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
      `SELECT m.peer_number AS number, fb.name AS fb_name, m.body AS last_body, m.created_at AS last_ts,
         (SELECT COUNT(*) FROM messages u WHERE u.peer_number = m.peer_number AND u.direction = 'inbound' AND u.read = 0 AND u.deleted_at IS NULL) AS unread
       FROM messages m
       JOIN (SELECT peer_number, MAX(created_at) AS mx FROM messages WHERE deleted_at IS NULL GROUP BY peer_number) latest
         ON m.peer_number = latest.peer_number AND m.created_at = latest.mx
       LEFT JOIN fb_contacts fb ON m.peer_number = 'messenger:' || fb.psid
       WHERE m.deleted_at IS NULL
       GROUP BY m.peer_number
       ORDER BY m.created_at DESC`
    )
    .all<{ number: string; fb_name: string | null; last_body: string; last_ts: number; unread: number }>();
  return rows.results.map((r) => ({
    number: r.number,
    name: r.fb_name ?? null,
    last_body: r.last_body,
    last_ts: r.last_ts,
    unread: r.unread,
  }));
}

// `limit` returns only the LAST n messages (still in ascending order) — used by the call-detail
// SMS peek, which only shows a handful and shouldn't pull a whole long-running thread out of D1.
export async function listThread(db: D1Database, peer: string, limit?: number): Promise<MessageRow[]> {
  if (limit != null) {
    const rows = await db
      .prepare(
        "SELECT * FROM (SELECT id, direction, body, created_at AS ts, status, error_code, error_message FROM messages WHERE peer_number = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?) ORDER BY ts ASC"
      )
      .bind(peer, limit)
      .all<MessageRow>();
    return rows.results;
  }
  const rows = await db
    .prepare(
      "SELECT id, direction, body, created_at AS ts, status, error_code, error_message FROM messages WHERE peer_number = ? AND deleted_at IS NULL ORDER BY created_at ASC"
    )
    .bind(peer)
    .all<MessageRow>();
  return rows.results;
}

// `deleted_at IS NULL` matters: a hidden thread is still reachable by number (Recents, and the
// Message action on a call detail, both route by peer rather than through the conversation list).
// Without the guard, opening a deleted conversation marks its hidden messages read, and the undo
// then restores them with their unread state gone -- the badge never comes back and two unanswered
// texts read as already handled. Hiding a thread must not quietly mutate what it hid.
export async function markThreadRead(db: D1Database, peer: string): Promise<void> {
  await db
    .prepare("UPDATE messages SET read = 1 WHERE peer_number = ? AND direction = 'inbound' AND deleted_at IS NULL")
    .bind(peer)
    .run();
}

// Applies a Twilio status-callback update (e.g. queued -> delivered/failed/undelivered) to an
// already-inserted outbound message. Twilio's initial 201 on send only means "accepted", not
// "delivered" -- for Facebook Messenger sends in particular, Meta can reject the message
// asynchronously (e.g. outside the 24-hour window, or a broken Page connection -- error 63001), and
// this callback is the only way that ever reaches the stored message status. A stray callback for
// an unknown id is a no-op. `error` captures Twilio's ErrorCode/ErrorMessage so a failure says why.
// Statuses a message does not come back from. Twilio's callbacks are NOT ordered -- a late `sent`
// can land after the `failed` it preceded -- so without this a delivery failure is overwritten by
// the very callback that came before it, taking its ErrorCode with it. The message then reads as
// fine in the app, and it drops out of checkMessengerChannelHealth's count, so the alert that
// exists to catch a Messenger outage goes quiet exactly when the outage is worst.
//
// `read` (Messenger and WhatsApp send it) earns its place by being protected FROM the non-terminal
// callbacks, not by outranking the other terminals: terminal-to-terminal is deliberately still
// allowed, so a late `delivered` can still land on top of it. Ordering the terminals against each
// other would be inventing a progression Twilio does not promise.
const TERMINAL_STATUSES = ["delivered", "failed", "undelivered", "read"];

export async function updateMessageStatus(
  db: D1Database,
  id: string,
  status: string,
  error?: { code: string | null; message: string | null }
): Promise<void> {
  const incomingIsTerminal = TERMINAL_STATUSES.includes(status);
  await db
    .prepare(
      // COALESCE on the error fields for the same reason tier 2 put it on the recording columns: a
      // later callback may ADD information about a message, never blank what an earlier one knew.
      `UPDATE messages
          SET status = ?,
              error_code = COALESCE(?, error_code),
              error_message = COALESCE(?, error_message)
        WHERE id = ?
          AND (? = 1 OR status IS NULL OR status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(", ")}))`
    )
    .bind(status, error?.code ?? null, error?.message ?? null, id, incomingIsTerminal ? 1 : 0, ...TERMINAL_STATUSES)
    .run();
}

// Hide a whole conversation. Threads are the unit people actually want gone -- a junk sender, not
// one text -- and hiding every message in it keeps the conversation list and the thread consistent.
//
// `deletedAt` is passed IN rather than read here, and that is the whole point: it is the undo token
// the caller hands back to the client, and restoreThread matches on it exactly. Calling Date.now()
// in here as well meant two independent readings either side of an await -- so whenever the
// millisecond ticked over between them, the token the client held was one behind the stamp actually
// stored, Undo matched no rows, and the conversation stayed hidden with "Nothing to restore".
export async function softDeleteThread(
  db: D1Database,
  peerNumber: string,
  byEmail: string,
  deletedAt: number
): Promise<number> {
  const res = await db
    .prepare("UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE peer_number = ? AND deleted_at IS NULL")
    .bind(deletedAt, byEmail, peerNumber)
    .run();
  return res.meta.changes ?? 0;
}

// Undo, scoped to the messages that one delete hid: restoring by peer alone would also resurrect a
// thread deleted last month and quietly re-open it.
export async function restoreThread(db: D1Database, peerNumber: string, deletedAt: number): Promise<number> {
  const res = await db
    .prepare("UPDATE messages SET deleted_at = NULL, deleted_by = NULL WHERE peer_number = ? AND deleted_at = ?")
    .bind(peerNumber, deletedAt)
    .run();
  return res.meta.changes ?? 0;
}

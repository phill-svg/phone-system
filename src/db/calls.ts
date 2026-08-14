export type CallSummary = {
  id: string;
  caller_number: string;
  called_number: string;
  started_at: number;
  ended_at: number | null;
  ivr_path: string | null;
  is_after_hours: number;
  status: string;
  recording_url: string | null;
  recording_sid: string | null;
  direction: "inbound" | "outbound";
  mailbox_label: string | null;
};

export type CallEventRow = {
  id: number;
  call_id: string;
  ts: number;
  event_type: string;
  detail: string | null;
};

export async function listCalls(db: D1Database, limit = 50): Promise<CallSummary[]> {
  const result = await db
    .prepare("SELECT * FROM calls ORDER BY started_at DESC LIMIT ?")
    .bind(limit)
    .all<CallSummary>();
  return result.results;
}

// Appends a row to the per-call event timeline (rendered on the call-detail page and in the
// softphone's call detail pane). Best-effort: callers wrap this so a logging failure never breaks
// live call handling.
export async function appendCallEvent(
  db: D1Database,
  callId: string,
  eventType: string,
  detail?: Record<string, unknown> | null
): Promise<void> {
  await db
    .prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
    .bind(callId, Date.now(), eventType, detail ? JSON.stringify(detail) : null)
    .run();
}

export async function listLiveCalls(db: D1Database): Promise<CallSummary[]> {
  const result = await db
    .prepare("SELECT * FROM calls WHERE status = 'in_progress' ORDER BY started_at DESC")
    .all<CallSummary>();
  return result.results;
}

export async function getCallDetail(
  db: D1Database,
  callId: string
): Promise<{ call: CallSummary; events: CallEventRow[] } | null> {
  const call = await db.prepare("SELECT * FROM calls WHERE id = ?").bind(callId).first<CallSummary>();
  if (!call) return null;
  const events = await db
    .prepare("SELECT * FROM call_events WHERE call_id = ? ORDER BY ts ASC")
    .bind(callId)
    .all<CallEventRow>();
  return { call, events: events.results };
}

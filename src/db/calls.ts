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
  recording_duration: number | null;
  direction: "inbound" | "outbound";
  mailbox_label: string | null;
  transcription: string | null;
  call_transcript: string | null;
  disposition: string | null;
  notes: string | null;
};

// Twilio sends RecordingDuration as a string of whole seconds on the recording-status callback.
// Returns null for absent, non-numeric, or nonsensical values so a bad payload leaves the stored
// duration untouched (callers pair this with COALESCE) rather than writing a wrong length.
export function parseRecordingDuration(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

export type CallStats = {
  total: number;
  inbound: number;
  outbound: number;
  answered: number;
  voicemail: number;
  missed: number;
  avgTalkSeconds: number;
  byDay: { day: string; total: number; answered: number }[];
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
  // Only calls started in the last 3 hours count as "live". If a call's completion status callback
  // is ever missed, its row lingers as `in_progress` forever — those stale rows must NOT show as
  // live (a real phone call never runs 3h), otherwise e.g. listen-in joins a long-dead conference
  // and just plays hold music.
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  const result = await db
    .prepare("SELECT * FROM calls WHERE status = 'in_progress' AND started_at >= ? ORDER BY started_at DESC")
    .bind(cutoff)
    .all<CallSummary>();
  return result.results;
}

// Sets the staff-entered disposition (outcome tag) and/or notes on a call.
export async function updateCallMeta(
  db: D1Database,
  callId: string,
  meta: { disposition?: string | null; notes?: string | null }
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE calls SET disposition = ?, notes = ? WHERE id = ?")
    .bind(meta.disposition ?? null, meta.notes ?? null, callId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Aggregates call metrics for the window [sinceMs, now). "answered" and "voicemail" are derived
// from the authoritative per-call event timeline (see appendCallEvent); an inbound call that was
// neither answered nor left a voicemail counts as missed.
export async function getCallStats(db: D1Database, sinceMs: number): Promise<CallStats> {
  const calls = (
    await db
      .prepare("SELECT id, started_at, ended_at, direction FROM calls WHERE started_at >= ?")
      .bind(sinceMs)
      .all<{ id: string; started_at: number; ended_at: number | null; direction: string }>()
  ).results;
  const answeredIds = new Set(
    (
      await db
        .prepare("SELECT DISTINCT call_id FROM call_events WHERE event_type = 'answered' AND ts >= ?")
        .bind(sinceMs)
        .all<{ call_id: string }>()
    ).results.map((r) => r.call_id)
  );
  const voicemailIds = new Set(
    (
      await db
        .prepare("SELECT DISTINCT call_id FROM call_events WHERE event_type = 'voicemail_left' AND ts >= ?")
        .bind(sinceMs)
        .all<{ call_id: string }>()
    ).results.map((r) => r.call_id)
  );

  let inbound = 0;
  let outbound = 0;
  let answered = 0;
  let voicemail = 0;
  let missed = 0;
  let talkTotal = 0;
  let talkCount = 0;
  const dayMap = new Map<string, { total: number; answered: number }>();

  for (const c of calls) {
    if (c.direction === "outbound") outbound++;
    else inbound++;
    const isAnswered = answeredIds.has(c.id);
    const isVoicemail = voicemailIds.has(c.id);
    if (isAnswered) {
      answered++;
      if (c.ended_at && c.ended_at > c.started_at) {
        talkTotal += (c.ended_at - c.started_at) / 1000;
        talkCount++;
      }
    } else if (isVoicemail) {
      voicemail++;
    } else if (c.direction === "inbound") {
      missed++;
    }
    const day = new Date(c.started_at).toISOString().slice(0, 10);
    const entry = dayMap.get(day) ?? { total: 0, answered: 0 };
    entry.total++;
    if (isAnswered) entry.answered++;
    dayMap.set(day, entry);
  }

  const byDay = [...dayMap.entries()]
    .map(([day, v]) => ({ day, total: v.total, answered: v.answered }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    total: calls.length,
    inbound,
    outbound,
    answered,
    voicemail,
    missed,
    avgTalkSeconds: talkCount ? Math.round(talkTotal / talkCount) : 0,
    byDay,
  };
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

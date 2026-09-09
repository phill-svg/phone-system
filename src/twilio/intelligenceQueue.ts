import {
  fetchSentences,
  fetchTranscriptStatus,
  formatLabelledTranscript,
  intelligenceEnabled,
  type IntelligenceEnv,
} from "./intelligence";

// Collects Twilio transcripts that were requested when a recording finished.
//
// Twilio transcribes asynchronously, so the recording webhook can only ASK; something has to come
// back later and collect. That is this, on the existing 5-minute cron.
//
// Bounded per tick, and every row reaches a terminal state (completed or failed) so the sweep drains
// and then does nothing. A transcript still queued after this many attempts is abandoned: the call
// keeps whatever Whisper wrote, which is worse but is not nothing.
export const MAX_INTELLIGENCE_POLLS = 12;
const BATCH = 5;

export type QueueEnv = IntelligenceEnv & { DB: D1Database };

type PendingRow = { id: string; intelligence_sid: string; intelligence_status: string | null };

export async function collectPendingTranscripts(env: QueueEnv): Promise<number> {
  if (!intelligenceEnabled(env)) return 0;

  const rows = (
    await env.DB.prepare(
      `SELECT id, intelligence_sid, intelligence_status
         FROM calls
        WHERE intelligence_sid IS NOT NULL
          AND deleted_at IS NULL
          AND (intelligence_status IS NULL OR intelligence_status NOT IN ('completed', 'failed'))
        ORDER BY started_at DESC
        LIMIT ?`
    )
      .bind(BATCH)
      .all<PendingRow>()
  ).results;
  if (rows.length === 0) return 0;

  let collected = 0;
  for (const row of rows) {
    const polls = Number(row.intelligence_status ?? "0") || 0;
    // Give up rather than poll a stuck job forever -- and record WHY, so a call sitting without a
    // labelled transcript is explainable months later.
    if (polls >= MAX_INTELLIGENCE_POLLS) {
      await setStatus(env, row.id, "failed");
      console.log("INTELLIGENCE_ABANDONED", JSON.stringify({ callId: row.id, sid: row.intelligence_sid }));
      continue;
    }

    const status = await fetchTranscriptStatus(env, row.intelligence_sid);
    if (status === "failed") {
      await setStatus(env, row.id, "failed");
      console.log("INTELLIGENCE_FAILED", JSON.stringify({ callId: row.id, sid: row.intelligence_sid }));
      continue;
    }
    if (status !== "completed") {
      // Count the attempt so a job that never finishes still terminates.
      await setStatus(env, row.id, String(polls + 1));
      continue;
    }

    const sentences = await fetchSentences(env, row.intelligence_sid);
    const text = formatLabelledTranscript(sentences, staffChannel());
    if (!text) {
      // Completed, but every sentence landed on one channel -- the recording was not dual-channel.
      // Labelling it would be a guess dressed as fact, so the Whisper transcript stands.
      await setStatus(env, row.id, "failed");
      console.log("INTELLIGENCE_SINGLE_CHANNEL", JSON.stringify({ callId: row.id, sid: row.intelligence_sid }));
      continue;
    }

    // Overwrites the Whisper transcript deliberately: same column, strictly better content, so every
    // screen that already renders `call_transcript` shows the labelled version with no change.
    await env.DB.prepare("UPDATE calls SET call_transcript = ?, intelligence_status = 'completed' WHERE id = ?")
      .bind(text, row.id)
      .run();
    collected += 1;
    console.log("INTELLIGENCE_COLLECTED", JSON.stringify({ callId: row.id, sid: row.intelligence_sid }));
  }
  return collected;
}

// Which channel the staff member is on. Twilio puts the FIRST participant to join a conference on
// channel 1; our staff leg renders the conference TwiML on answer and the caller is REST-redirected
// in afterwards, so staff are first. Isolated here so it is one edit if that ever changes.
function staffChannel(): 1 | 2 {
  return 1;
}

async function setStatus(env: QueueEnv, callId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE calls SET intelligence_status = ? WHERE id = ?").bind(status, callId).run();
}

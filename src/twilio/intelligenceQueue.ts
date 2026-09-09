import { getTranscriptStaffChannel } from "../db/settings";
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

type PendingRow = {
  id: string;
  intelligence_sid: string;
  intelligence_status: string | null;
  intelligence_polls: number | null;
};

export async function collectPendingTranscripts(env: QueueEnv): Promise<number> {
  if (!intelligenceEnabled(env)) return 0;

  const rows = (
    await env.DB.prepare(
      `SELECT id, intelligence_sid, intelligence_status, intelligence_polls
         FROM calls
        WHERE intelligence_sid IS NOT NULL
          AND deleted_at IS NULL
          AND intelligence_status = 'pending'
        ORDER BY started_at DESC
        LIMIT ?`
    )
      .bind(BATCH)
      .all<PendingRow>()
  ).results;
  if (rows.length === 0) return 0;

  let collected = 0;
  for (const row of rows) {
    const polls = row.intelligence_polls ?? 0;
    // Give up rather than poll a stuck job forever -- and record WHY, so a call sitting without a
    // labelled transcript is explainable months later.
    if (polls >= MAX_INTELLIGENCE_POLLS) {
      await setStatus(env, row.id, "abandoned");
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
      await env.DB.prepare("UPDATE calls SET intelligence_polls = ? WHERE id = ?").bind(polls + 1, row.id).run();
      continue;
    }

    const sentences = await fetchSentences(env, row.intelligence_sid);
    const text = formatLabelledTranscript(sentences, await getTranscriptStaffChannel(env.DB));
    if (!text) {
      // Completed, but every sentence landed on one channel -- the recording was not dual-channel.
      // Labelling it would be a guess dressed as fact, so the Whisper transcript stands.
      // A DISTINCT status, not a generic failure: this one says the Console's dual-channel
      // conference recording switch is off, which is fixable and affects every call. Collapsing it
      // into "failed" is what would make that unanswerable six months later.
      await setStatus(env, row.id, "single_channel");
      console.log("INTELLIGENCE_SINGLE_CHANNEL", JSON.stringify({ callId: row.id, sid: row.intelligence_sid }));
      continue;
    }

    // Overwrites the Whisper transcript deliberately: same column, strictly better content, so every
    // screen that already renders `call_transcript` shows the labelled version with no change.
    //
    // The status is set in the SAME statement, and backfillTranscripts now refuses to write over a
    // row whose intelligence_status is 'completed'. Without that pair, the two writers race inside
    // one cron tick -- backfill SELECTs a row with a NULL transcript, spends 10-30s in Workers AI,
    // and lands its unlabelled blob on top of the labelled text this just wrote, permanently.
    await env.DB.prepare("UPDATE calls SET call_transcript = ?, intelligence_status = 'completed' WHERE id = ?")
      .bind(text, row.id)
      .run();
    collected += 1;
    console.log("INTELLIGENCE_COLLECTED", JSON.stringify({ callId: row.id, sid: row.intelligence_sid }));
  }
  return collected;
}

async function setStatus(env: QueueEnv, callId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE calls SET intelligence_status = ? WHERE id = ?").bind(status, callId).run();
}

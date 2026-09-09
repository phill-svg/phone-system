-- migrations/0034_call_transcript_intelligence.sql
-- Twilio Conversational Intelligence transcripts, which say who said what.
--
-- Whisper returns one undifferentiated block: it has no speaker diarization, and a Conference
-- recording is mixed to a single mono track by default, so both halves of a call ran together in
-- `call_transcript` with no way to tell the caller from whoever answered.
--
-- Twilio's transcription is asynchronous -- create it, then collect it later -- so the call needs
-- somewhere to remember the job between those two moments. That is all these columns are.
--
-- `intelligence_sid` NULL = never requested (no service configured, or not an answered call).
-- `intelligence_status` tracks the job so the cron sweep knows what is still worth polling and
-- stops chasing one that failed.
ALTER TABLE calls ADD COLUMN intelligence_sid TEXT;

-- A STATE, never a counter. The two were one column at first, which collapsed three different
-- endings into the single word "failed" -- and the one that matters most, "the Console's
-- dual-channel switch is off", became indistinguishable from "that job got stuck". The states are
-- 'pending', 'completed', 'failed' (Twilio rejected it), 'single_channel' (dual-channel recording is
-- off, so speaker labels would be a guess) and 'abandoned' (never finished).
ALTER TABLE calls ADD COLUMN intelligence_status TEXT;
ALTER TABLE calls ADD COLUMN intelligence_polls INTEGER NOT NULL DEFAULT 0;

-- The sweep asks exactly one question: which transcripts are still outstanding?
--
-- The predicate is `= 'pending'`, matching the query EXACTLY. An earlier version used
-- `NOT IN ('completed','failed')` while the query said `status IS NULL OR NOT IN (...)`: in SQLite
-- `NULL NOT IN (...)` is NULL, so the index excluded the very rows the query admitted, SQLite could
-- not prove the predicate held, and it silently fell back to scanning the whole calls table on every
-- tick -- the exact cost this index exists to avoid.
CREATE INDEX idx_calls_intelligence_pending
  ON calls(started_at)
  WHERE intelligence_status = 'pending';

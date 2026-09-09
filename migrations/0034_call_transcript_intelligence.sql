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
ALTER TABLE calls ADD COLUMN intelligence_status TEXT;

-- The sweep asks exactly one question: which transcripts are still outstanding? A partial index
-- keeps that from scanning the whole call history, and completed/failed rows drop out of it.
CREATE INDEX idx_calls_intelligence_pending
  ON calls(intelligence_sid)
  WHERE intelligence_sid IS NOT NULL AND intelligence_status NOT IN ('completed', 'failed');

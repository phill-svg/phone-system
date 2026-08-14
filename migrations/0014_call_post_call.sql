-- migrations/0015_call_post_call.sql
-- Post-call fields: Twilio voicemail transcription text, plus a staff-set disposition (outcome
-- tag) and free-text notes shown on the call-detail pane.
ALTER TABLE calls ADD COLUMN transcription TEXT;
ALTER TABLE calls ADD COLUMN disposition TEXT;
ALTER TABLE calls ADD COLUMN notes TEXT;

-- Recording length in whole seconds, as reported by Twilio's RecordingDuration parameter on the
-- recording-status callback. Nullable on purpose: the recording row is written when the URL/SID
-- first arrive, which can precede (or, for voicemail, come from a different callback than) the
-- duration -- so clients must fall back to the player's own metadata when this is NULL rather
-- than rendering a wrong length.
ALTER TABLE calls ADD COLUMN recording_duration INTEGER;

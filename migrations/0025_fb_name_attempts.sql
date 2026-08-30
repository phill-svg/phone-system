-- Facebook Messenger name-lookup bookkeeping.
--
-- A sender's name is fetched from the Graph API once, when their first message arrives (see
-- worker.ts, the /webhooks/twilio/sms route). If that call fails -- an expired Page access token,
-- a transient Graph error -- nothing ever tries again, so the inbox shows "Facebook user" for
-- that person forever. The cron sweep in facebook/backfill.ts retries them.
--
-- attempts is what stops the sweep looping on a psid the token genuinely cannot read: it drains
-- and then does nothing, the same way transcribe_attempts caps the transcript backfill.
-- last_error keeps Facebook's own explanation, so a stuck sender can say WHY it is stuck instead
-- of looking like it was never tried.
CREATE TABLE IF NOT EXISTS fb_name_attempts (
  psid TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

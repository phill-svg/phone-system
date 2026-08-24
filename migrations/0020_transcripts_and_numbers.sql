-- Full-call transcript (Cloudflare Workers AI Whisper), kept separate from the voicemail
-- `transcription` column so the two never overwrite each other.
ALTER TABLE calls ADD COLUMN call_transcript TEXT;

-- Sending numbers the user can pick from (voice caller-ID and/or SMS "from"). Seeded with the two
-- current numbers; ported/real numbers get inserted here later and appear in the pickers automatically.
CREATE TABLE IF NOT EXISTS phone_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  e164 TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  voice_enabled INTEGER NOT NULL DEFAULT 0,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  is_default_voice INTEGER NOT NULL DEFAULT 0,
  is_default_sms INTEGER NOT NULL DEFAULT 0,
  region TEXT,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO phone_numbers
  (e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region, created_at)
VALUES
  ('+61866108941', 'Main line', 1, 0, 1, 0, 'au1', 0),
  ('+61485034869', 'SMS line',  0, 1, 0, 1, 'us1', 0);

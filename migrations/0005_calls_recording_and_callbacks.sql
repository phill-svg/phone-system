-- migrations/0005_calls_recording_and_callbacks.sql
ALTER TABLE calls ADD COLUMN recording_url TEXT;
ALTER TABLE calls ADD COLUMN recording_sid TEXT;
ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE calls ADD COLUMN mailbox_label TEXT;

CREATE TABLE callback_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id      TEXT NOT NULL REFERENCES calls(id),
  caller_number TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done'))
);

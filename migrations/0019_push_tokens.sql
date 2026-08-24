-- Device push tokens for staff notifications (e.g. inbound SMS). One row per Expo push token;
-- re-registering the same token just refreshes staff_email / last_seen.
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  staff_email TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

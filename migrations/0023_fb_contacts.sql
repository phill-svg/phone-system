-- Cached Facebook Messenger sender names, keyed by PSID (the id in "messenger:<psid>" peer_number
-- values). Resolved via the Graph API on first inbound message from a given PSID and reused after
-- that so we don't call out to Facebook on every message.
CREATE TABLE IF NOT EXISTS fb_contacts (
  psid       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

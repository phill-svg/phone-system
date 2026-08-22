-- migrations/0018_messages.sql
-- SMS messages to/from customers. peer_number is always the customer's E.164 number (the recipient
-- for outbound, the sender for inbound); the business number is implicit.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,               -- Twilio MessageSid (or a generated id for inbound with none)
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  peer_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT,
  read INTEGER NOT NULL DEFAULT 0,   -- inbound unread tracking (1 once viewed)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_peer ON messages (peer_number, created_at);

-- Record which BUSINESS number a message went through (Twilio "To" on inbound, "From" on outbound).
-- Threads stay keyed by peer_number, but with a multi-number SMS "from" picker this is the only way
-- to know which line a conversation happened on (and which line a reply should default to).
-- Nullable: rows from before this migration are unknown.
ALTER TABLE messages ADD COLUMN our_number TEXT;

-- migrations/0032_soft_delete_calls_messages.sql
-- Deleting a call log or a conversation HIDES it rather than destroying it.
--
-- These are business-wide records: one admin deleting removes it for everyone, and a call log is
-- the evidence in a customer dispute. A row that is merely hidden can be brought back from a
-- mis-tap; a deleted one cannot. `call_events` and `callback_requests` also carry foreign keys to
-- calls(id), so a real DELETE would have to cascade -- another reason not to.
--
-- deleted_at NULL = visible. Every read of calls/messages in the app filters on it.
ALTER TABLE calls ADD COLUMN deleted_at INTEGER;
ALTER TABLE calls ADD COLUMN deleted_by TEXT;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_by TEXT;

-- Partial indexes: every list read is "not deleted, newest first", and deleted rows drop out of the
-- index entirely rather than being scanned and discarded.
CREATE INDEX idx_calls_not_deleted ON calls(started_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_not_deleted ON messages(peer_number, created_at) WHERE deleted_at IS NULL;

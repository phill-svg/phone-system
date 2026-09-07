-- migrations/0031_servicem8_sync_queue.sql
-- ServiceM8 work no longer runs the instant a call ends. Staff often create the ServiceM8 client
-- or job DURING or just after the call, so firing immediately looked the number up before the
-- record existed, found nothing, and never tried again -- the note and the contact were both lost
-- for that call. It now runs on the cron a few minutes later; this column is what remembers which
-- calls are still owed that work.
--
-- NULL  = not yet done (the cron will pick it up once it is old enough)
-- number = ms epoch when it was claimed/completed, and the reason it is never done twice
ALTER TABLE calls ADD COLUMN servicem8_synced_at INTEGER;

-- The sweep asks one question every minute: "unsynced calls, oldest first". A partial index keeps
-- that O(pending) rather than O(all calls ever), and stays tiny because rows leave it once synced.
CREATE INDEX idx_calls_servicem8_pending ON calls(ended_at) WHERE servicem8_synced_at IS NULL;

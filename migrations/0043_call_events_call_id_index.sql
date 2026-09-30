-- call_events had no index at all, so `WHERE call_id = ?` was a full table scan.
--
-- listCalls asks two correlated questions per call row (was it answered, how many events) and
-- returns up to 2000 calls, so ONE Recents load scanned call_events about 4000 times over. With
-- roughly 1,800 events that is millions of rows read per request, and Cloudflare's free D1 tier
-- allows 5 million a day: on 2026-09-30 the account hit the cap and D1 refused every read, which
-- took the whole phone system down (calls, web dashboard and app).
--
-- Additive only. (call_id, event_type) covers both the EXISTS(... 'answered') and the COUNT(*).
CREATE INDEX IF NOT EXISTS idx_call_events_call_type ON call_events(call_id, event_type);

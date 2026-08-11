-- migrations/0008_softphone.sql
ALTER TABLE staff_users ADD COLUMN status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('available','away','offline'));
ALTER TABLE staff_users ADD COLUMN away_reason TEXT;
ALTER TABLE staff_users ADD COLUMN schedule TEXT NOT NULL DEFAULT '{"mon":{"open":"07:00","close":"17:00"},"tue":{"open":"07:00","close":"17:00"},"wed":{"open":"07:00","close":"17:00"},"thu":{"open":"07:00","close":"17:00"},"fri":{"open":"07:00","close":"17:00"},"sat":null,"sun":null}';
ALTER TABLE staff_users ADD COLUMN last_heartbeat_at INTEGER;

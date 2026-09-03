-- migrations/0028_staff_status_set_on.sql
-- Availability is a per-person override that EXPIRES DAILY. `status_set_on` records the Canberra
-- calendar date (YYYY-MM-DD) on which a staff member last set their own status, so the cron can
-- tell "I marked myself unavailable today" from "I marked myself unavailable last Tuesday and
-- forgot". A stale override is reset to available, which is what stops someone silently dropping
-- off the ring roster for weeks after one sick day.
-- NULL means the status was never set by the person (or has been reset) and carries no weight.
ALTER TABLE staff_users ADD COLUMN status_set_on TEXT;

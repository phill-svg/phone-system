-- migrations/0014_staff_ring_priority.sql
-- Per-staff ring priority for cascade routing: lower number rings earlier (e.g. 10 = senior rep
-- rings before a 100 = general fallback). Default 100 so existing staff share one tier and fall
-- back to a stable alphabetical order until priorities are set.
ALTER TABLE staff_users ADD COLUMN ring_priority INTEGER NOT NULL DEFAULT 100;

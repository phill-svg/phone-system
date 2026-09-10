-- After-hours on-call rotation.
--
-- Before this, the closed branch of the IVR went straight to the "after hours" voicemail node:
-- every call outside business hours reached a machine, because resolveRingTargets only ever
-- returns people who are ON SHIFT and after hours that set is empty by construction.
--
-- The rotation ITSELF lives in `settings` (key `on_call_rotation`) rather than here, because it is
-- one ordered list edited as a whole -- the same shape as business_hours and the call blocklist.
-- What needs a table is the per-week OVERRIDE: a swap is a fact about one specific week, it is
-- created and deleted independently, and keeping a history of who actually covered which week is
-- worth having when someone asks why their phone rang at 2am.
--
-- week_start is the Monday of the covered week as a Sydney YYYY-MM-DD date key, and is the primary
-- key: one person covers a week, and re-assigning replaces rather than accumulates.
CREATE TABLE IF NOT EXISTS on_call_overrides (
  week_start   TEXT PRIMARY KEY,
  staff_email  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT
);

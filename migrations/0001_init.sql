CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE calls (
  id             TEXT PRIMARY KEY,
  caller_number  TEXT NOT NULL,
  called_number  TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  ivr_path       TEXT,
  is_after_hours INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL REFERENCES calls(id),
  ts         INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail     TEXT
);

-- Per-user preferences (notifications, ring-my-mobile). Keyed by staff email so they survive
-- reinstall / new device. Values are JSON-encoded scalars. Business-wide config stays in `settings`.
CREATE TABLE IF NOT EXISTS user_settings (
  email      TEXT NOT NULL REFERENCES staff_users(email),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, key)
);

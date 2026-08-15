-- migrations/0016_auth.sql
-- Custom email+password auth: passwords on staff_users, server-side sessions,
-- single-use email tokens (invite/reset), and a login rate-limit ledger.
ALTER TABLE staff_users ADD COLUMN password_hash TEXT;       -- NULL = invited, password not yet set
ALTER TABLE staff_users ADD COLUMN password_set_at INTEGER;  -- ms epoch, NULL until set

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the opaque cookie token
  email      TEXT NOT NULL REFERENCES staff_users(email),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_email ON sessions(email);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE password_tokens (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the one-time link token
  email      TEXT NOT NULL REFERENCES staff_users(email),
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER             -- NULL until consumed; single-use
);
CREATE INDEX idx_password_tokens_email ON password_tokens(email);

CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, attempted_at);

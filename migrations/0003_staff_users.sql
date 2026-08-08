-- migrations/0003_staff_users.sql
CREATE TABLE staff_users (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at INTEGER NOT NULL
);

INSERT INTO staff_users (email, role, created_at)
VALUES ('phill@tcbpestcontrolcanberra.com.au', 'admin', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

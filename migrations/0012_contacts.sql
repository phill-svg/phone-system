-- migrations/0012_contacts.sql
-- Contact book for the softphone. phone_normalized holds a digits-only, AU-normalized form of
-- `phone` (see normalizePhone in src/db/contacts.ts) so inbound/outbound call numbers can be
-- matched to a contact name regardless of formatting (spaces, +61 vs leading 0, etc.).
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone_normalized ON contacts(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

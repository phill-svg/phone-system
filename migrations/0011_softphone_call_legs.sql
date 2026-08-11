-- migrations/0011_softphone_call_legs.sql
CREATE TABLE softphone_call_legs (
  call_sid TEXT PRIMARY KEY,
  staff_email TEXT NOT NULL,
  conference_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

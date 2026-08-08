-- migrations/0002_call_lifecycle.sql
ALTER TABLE calls ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress';
ALTER TABLE calls ADD COLUMN ended_at INTEGER;

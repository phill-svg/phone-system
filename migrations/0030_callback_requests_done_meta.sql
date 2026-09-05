-- migrations/0030_callback_requests_done_meta.sql
-- Record WHEN a callback request was handled and BY WHOM. Until now the only trace of handling was
-- status flipping to 'done', which loses both -- so a completed list could only be sorted by when
-- the caller asked, and never answered "did anyone actually ring them back, and who?".
--
-- Both nullable with no default: a row that is still open has genuinely not been handled, and NULL
-- says that better than 0 or ''. The PATCH/PUT handler stamps them on the way to 'done' and clears
-- them on the way back to 'open', so the pair is always consistent with status.
--
-- Plain ADD COLUMNs -- no table rebuild needed here (unlike 0029, which had to recreate ivr_nodes
-- because SQLite cannot ALTER a CHECK constraint). callback_requests' CHECK is on status, untouched.
ALTER TABLE callback_requests ADD COLUMN done_at INTEGER;
ALTER TABLE callback_requests ADD COLUMN done_by TEXT;

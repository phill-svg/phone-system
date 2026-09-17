-- Which session registered each push token.
--
-- Every business push goes to every row in push_tokens, and a push carries a customer's name and the
-- first 240 characters of their text. Nothing tied a token to anyone still signed in: signing out
-- destroyed the session and left the token, and a password reset did the same, so a signed-out
-- handset kept showing customer messages on its lock screen indefinitely.
--
-- Senders now skip a row whose session no longer exists. NULL is a row written before this shipped;
-- those keep receiving, or every phone would go quiet the moment this deployed, and a signed-in
-- handset replaces NULL the next time the app opens.
--
-- A handset that was ALREADY signed out never registers again, so its NULL row would never be
-- replaced and would leak forever. Rows whose owner has no session at all are exactly those, and are
-- deleted here. (Checked live 2026-09-17: two rows, both owned by someone with live sessions, so this
-- deletes nothing today. It is here for any other copy of this database.)
ALTER TABLE push_tokens ADD COLUMN session_hash TEXT;

DELETE FROM push_tokens
WHERE staff_email IS NULL
   OR staff_email NOT IN (SELECT email FROM sessions);

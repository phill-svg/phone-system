-- Per-number IVR routing: each phone number can enter its own flow instead of every inbound call
-- being funnelled through the one hardcoded pair ("main" in hours, "after_hours" outside them).
--
-- Both columns are NULLABLE and default to NULL ON PURPOSE. NULL means "this number has never been
-- given a route of its own", and resolves at call time to the global default. Storing the literal
-- 'main'/'after_hours' as a default instead would pin every existing number to today's flow names
-- and silently break the moment those defaults change -- and, worse, would make a row that was
-- never configured indistinguishable from one an admin deliberately pointed at `main`.
--
-- A number with no row here at all (a Twilio number nobody added on /admin/settings) keeps working
-- exactly as before: the resolver falls back to the same defaults. See src/ivr/numberRouting.ts.
ALTER TABLE phone_numbers ADD COLUMN ivr_flow TEXT;
ALTER TABLE phone_numbers ADD COLUMN after_hours_flow TEXT;

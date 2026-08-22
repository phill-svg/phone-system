-- migrations/0017_outbound_target_sid.sql
-- The dialed-out (target) leg SID of a softphone outbound call, so an agent hang-up before the
-- callee answers can cancel that leg instead of leaving the callee's phone ringing.
ALTER TABLE calls ADD COLUMN outbound_target_sid TEXT;

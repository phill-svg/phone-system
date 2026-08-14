-- migrations/0013_staff_mobile_number.sql
-- Re-add a per-staff mobile number for PSTN failover: when a staff member's browser softphone
-- isn't answered, the ring plan falls through to their mobile so calls still get picked up.
-- (mobile_number was originally added in 0006 and dropped in 0009; reintroduced here for the
-- ring-to-mobile failover feature.)
ALTER TABLE staff_users ADD COLUMN mobile_number TEXT;

-- migrations/0026_message_delivery_errors.sql
-- Captures the actual Twilio error on a failed outbound message (e.g. 63001 "Channel
-- authentication failed"), so a "Not delivered" message can say why instead of just failing
-- silently -- see src/twilio/statusCallback errors and the /webhooks/twilio/sms-status handler.
ALTER TABLE messages ADD COLUMN error_code TEXT;
ALTER TABLE messages ADD COLUMN error_message TEXT;

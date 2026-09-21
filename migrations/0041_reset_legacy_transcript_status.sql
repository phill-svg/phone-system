-- `intelligence_status` used to track Twilio's Conversational Intelligence: a transcript was
-- requested, polled, and collected. That pipeline is gone -- Twilio does not support Conversation
-- Intelligence (classic) in AU1, so it could never work for this account's landline, and the
-- labelling is done in the worker now.
--
-- The column stays, and records how the LABELLING went. These four values belong to the old
-- pipeline and nothing will ever move them on: `pending` waited for a sweep that no longer runs,
-- `request_failed` is the au1 rejection itself, and `abandoned`/`no_speech` were verdicts on a
-- transcript Twilio held. Left as they are, they would sit in the table matching
-- `intelligence_status IS NOT NULL` while counting towards nothing on Admin > Health Checks, which
-- is the reassuring silence that screen exists to break.
--
-- NULL means "never labelled", which is exactly true of these calls. They keep their plain
-- transcripts; nothing here touches `call_transcript`.
UPDATE calls
   SET intelligence_status = NULL,
       intelligence_sid = NULL,
       intelligence_error = NULL
 WHERE intelligence_status IN ('pending', 'request_failed', 'abandoned', 'no_speech', 'failed');

-- Pictures a customer sends us.
--
-- Twilio delivers an attachment as `NumMedia` plus `MediaUrlN`/`MediaContentTypeN` on the inbound
-- webhook. Nothing read those fields, so a customer's photo arrived as a message with an empty body
-- and no indication anything was missing -- the picture of the rat, the meter box, the job site,
-- gone, with staff seeing a blank text.
--
-- A TABLE rather than columns on `messages`, because one message can carry several attachments
-- (Twilio allows up to ten) and a column pair per slot would cap it arbitrarily and read badly.
--
-- `url` is Twilio's own media URL, not a copy of the bytes. It needs the account's credentials to
-- fetch, so it is proxied through the worker rather than handed to a client -- the same shape as
-- call recordings, which are already served that way. Storing the URL rather than the file keeps
-- D1 small; the cost is that the media lives as long as Twilio keeps it.
CREATE TABLE message_media (
  message_id   TEXT NOT NULL REFERENCES messages(id),
  idx          INTEGER NOT NULL,          -- Twilio's zero-based MediaUrlN index
  content_type TEXT NOT NULL,             -- e.g. image/jpeg, application/pdf
  url          TEXT NOT NULL,
  PRIMARY KEY (message_id, idx)
);

-- The thread view asks for every attachment of the messages it just loaded, so the lookup is by
-- message.
CREATE INDEX idx_message_media_message ON message_media (message_id);

// Friendly text for the Twilio error codes most likely to show up on a failed Facebook Messenger
// (or WhatsApp) send, so a "Not delivered" message can say something useful even when Twilio's
// status callback doesn't include its own ErrorMessage. Not exhaustive -- an unknown code still
// shows, just without the extra sentence. See https://www.twilio.com/docs/api/errors/<code>.
const CHANNEL_ERROR_TEXT: Record<string, string> = {
  "63001": "Channel authentication failed -- the Facebook Page connection in Twilio needs reconnecting.",
  "63003": "Twilio couldn't find that recipient on this channel.",
  "63007": "Twilio couldn't find a channel for the configured From address.",
  "63016": "Message sent outside Facebook's 24-hour reply window without an allowed tag.",
  "63024": "Recipient hasn't opted in to receive messages on this channel.",
  "63039": "Facebook is throttling this Page for messaging outside the 24-hour window too often.",
};

export function describeChannelError(code: string | null | undefined): string | null {
  if (!code) return null;
  return CHANNEL_ERROR_TEXT[code] ?? null;
}

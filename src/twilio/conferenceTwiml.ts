import { wrapResponse } from "./flowTwiml";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Media-mixing region only (this is a plain us1 account; conferences are account-global). Pinned
// to Sydney because both the callers and the staff softphone are in Australia -- keeps audio
// latency low and deterministic for every leg.
const CONFERENCE_REGION = "au1";

// While the far end is being dialed, the waiting party hears a ringing tone (Twilio's own
// outgoing-call ringback) instead of hold music, so a call sounds like a normal ringing phone.
// beep is disabled so there's no chime when the other party joins.
const RINGBACK_URL = "https://sdk.twilio.com/js/client/sounds/releases/1.0.0/outgoing.mp3";

export function renderJoinConference(opts: { conferenceName: string }): string {
  return wrapResponse(
    `<Dial><Conference region="${CONFERENCE_REGION}" beep="false" waitUrl="${RINGBACK_URL}">${escapeXml(opts.conferenceName)}</Conference></Dial>`
  );
}

export function renderDialAgentIntoConference(opts: {
  conferenceName: string;
  actionUrl: string;
  recordingStatusCallbackUrl: string;
}): string {
  return wrapResponse(
    `<Dial action="${escapeXml(opts.actionUrl)}" method="POST">` +
      `<Conference region="${CONFERENCE_REGION}" beep="false" waitUrl="${RINGBACK_URL}" record="record-from-start" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" ` +
      `recordingStatusCallbackMethod="POST">${escapeXml(opts.conferenceName)}</Conference>` +
      `</Dial>`
  );
}

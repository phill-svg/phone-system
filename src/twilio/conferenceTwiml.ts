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

// While the far end is being dialed, the waiting party hears a ringing tone instead of hold music,
// so a call sounds like a normal ringing phone. beep is disabled so there's no chime when the other
// party joins.
//
// SELF-HOSTED: this used to point at sdk.twilio.com/.../outgoing.mp3, but Twilio's media servers
// started getting HTTP 403 when fetching that CDN asset server-side (as a Conference waitUrl),
// causing error 11200 → "an application error has occurred" the moment a caller sat alone in the
// conference (i.e. while ringing out). We now serve an identical copy from our own /media route,
// which Twilio fetches reliably. Do NOT revert to an sdk.twilio.com URL.
const RINGBACK_URL = "https://phone.tcbpestcontrolcanberra.com.au/media/system/ringback.mp3";

export function renderJoinConference(opts: { conferenceName: string }): string {
  return wrapResponse(
    `<Dial><Conference region="${CONFERENCE_REGION}" beep="false" waitUrl="${RINGBACK_URL}">${escapeXml(opts.conferenceName)}</Conference></Dial>`
  );
}

// Supervisor "listen in": join an existing call's conference MUTED so the listener hears both
// parties but can't be heard, and doesn't start/end the conference (so joining/leaving never
// affects the real call). beep=false so the parties get no join/leave chime.
export function renderListenConference(opts: { conferenceName: string }): string {
  return wrapResponse(
    `<Dial><Conference region="${CONFERENCE_REGION}" beep="false" muted="true" ` +
      `startConferenceOnEnter="false" endConferenceOnExit="false">${escapeXml(opts.conferenceName)}</Conference></Dial>`
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

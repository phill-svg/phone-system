import { wrapResponse, escapeXml } from "./flowTwiml";
import { RINGBACK_URL } from "./ringback";

// Media-mixing region only (this is a plain us1 account; conferences are account-global). Pinned
// to Sydney because both the callers and the staff softphone are in Australia -- keeps audio
// latency low and deterministic for every leg.
const CONFERENCE_REGION = "au1";

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
  record?: boolean;
}): string {
  const rec =
    opts.record === false
      ? ""
      : ` record="record-from-start" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" recordingStatusCallbackMethod="POST"`;
  return wrapResponse(
    `<Dial action="${escapeXml(opts.actionUrl)}" method="POST">` +
      `<Conference region="${CONFERENCE_REGION}" beep="false" waitUrl="${RINGBACK_URL}"${rec}>${escapeXml(opts.conferenceName)}</Conference>` +
      `</Dial>`
  );
}

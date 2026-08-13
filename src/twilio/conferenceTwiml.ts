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

export function renderJoinConference(opts: { conferenceName: string }): string {
  return wrapResponse(`<Dial><Conference region="${CONFERENCE_REGION}">${escapeXml(opts.conferenceName)}</Conference></Dial>`);
}

export function renderDialAgentIntoConference(opts: {
  conferenceName: string;
  actionUrl: string;
  recordingStatusCallbackUrl: string;
}): string {
  return wrapResponse(
    `<Dial action="${escapeXml(opts.actionUrl)}" method="POST">` +
      `<Conference region="${CONFERENCE_REGION}" record="record-from-start" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" ` +
      `recordingStatusCallbackMethod="POST">${escapeXml(opts.conferenceName)}</Conference>` +
      `</Dial>`
  );
}

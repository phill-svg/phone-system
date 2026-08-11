import { wrapResponse } from "./flowTwiml";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderJoinConference(opts: { conferenceName: string }): string {
  return wrapResponse(`<Dial><Conference>${escapeXml(opts.conferenceName)}</Conference></Dial>`);
}

export function renderDialAgentIntoConference(opts: {
  conferenceName: string;
  actionUrl: string;
  recordingStatusCallbackUrl: string;
}): string {
  return wrapResponse(
    `<Dial action="${escapeXml(opts.actionUrl)}" method="POST">` +
      `<Conference record="record-from-start" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" ` +
      `recordingStatusCallbackMethod="POST">${escapeXml(opts.conferenceName)}</Conference>` +
      `</Dial>`
  );
}

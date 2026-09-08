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

// "Call via my mobile": the staff member has answered their mobile, so dial the customer and bridge
// them. `callerId` is the business number, so the customer sees the office, not a personal mobile.
//
// `answerOnBridge` matters here: without it Twilio answers the staff leg immediately and they hear
// silence while the customer's phone rings. With it they hear real ringback, which is what any
// phone call sounds like -- and if the customer never answers, the staff leg is never billed as
// connected either.
//
// There is deliberately NO `action` on this Dial. An action URL must return TwiML, and pointing one
// at a status-callback endpoint (which answers with a plain "ok") made Twilio play "an application
// error has occurred" to the staff member at the end of EVERY call. Without it, Twilio simply falls
// off the end of the document and hangs up, which is what we want; the parent call's statusCallback
// already records how the call finished.
export function renderBridgeToCustomer(opts: {
  to: string;
  callerId: string;
  recordingStatusCallbackUrl: string;
  record?: boolean;
}): string {
  const rec =
    opts.record === false
      ? ""
      : ` record="record-from-answer" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" recordingStatusCallbackMethod="POST"`;
  return wrapResponse(
    `<Dial answerOnBridge="true" callerId="${escapeXml(opts.callerId)}"${rec}>` +
      `<Number>${escapeXml(opts.to)}</Number>` +
      `</Dial>`
  );
}

// The staff member's own voicemail picked up instead of them. Hanging up here is the entire reason
// answering-machine detection runs on that leg: the alternative is dialling the customer and
// connecting them to a stranger's voicemail greeting.
export function renderAbandonToVoicemail(): string {
  return wrapResponse("<Hangup/>");
}

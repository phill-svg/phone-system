import { wrapResponse, escapeXml } from "./flowTwiml";
import { RINGBACK_URL } from "./ringback";

// Media-mixing region only (this is a plain us1 account; conferences are account-global). Pinned
// to Sydney because both the callers and the staff softphone are in Australia -- keeps audio
// latency low and deterministic for every leg.
const CONFERENCE_REGION = "au1";

// The CALLER's leg joining the conference -- and, since 2026-09-12, THE ONE LEG THAT RECORDS an
// inbound call. Everything about that choice follows from which leg this document belongs to.
//
// Speaker labelling needs two channels, and a <Conference> recording's channel count is governed by
// one account-wide Console switch that was verified Enabled and saved while Twilio kept returning
// `channels: 1` for every conference recording on the account (checked 2026-09-12). So the recording
// has to be a `<Dial>` recording -- `record-from-answer-dual`, which no account setting touches.
//
// The first attempt put it on the STAFF leg's <Dial> (renderDialAgentIntoConference) and /code-review
// caught two faults in that, both of which this placement removes rather than mitigates:
//
//   1. A <Dial> recording belongs to EVERY leg that renders the document, and two do on a warm
//      transfer (the original staff leg, then the target's). Both post to the same
//      recording-status callback, `recording_url` is COALESCE/last-write-wins, and the pre-transfer
//      half of the conversation was orphaned in Twilio -- plus a doubled Intelligence bill and a
//      second `pending` write that could reset an already-completed transcript.
//   2. "Channel 1 is the staff member" was only true where the parent call IS the staff member.
//      /twiml/voice-app dials the CUSTOMER through the same document, so on that leg channel 1 is
//      the customer and every such transcript would be labelled backwards and presented as fact.
//
// The caller's leg has neither problem. There is exactly ONE caller, their leg lasts the WHOLE call
// (staff legs come and go across a transfer; the customer never leaves the conference), so this is
// one continuous recording per call and no future flow can add a second. And the parent call is
// always the customer, so channel 1 is always the customer and channel 2 is always whoever they are
// speaking to -- which is why `transcript_staff_channel` is back to its original default of 2.
//
// Recording therefore does NOT belong on the staff leg. `renderDialAgentIntoConference` keeps a
// conference-level recording for the flows where no caller-owned <Dial> exists (outbound softphone),
// and the inbound staff-answer path passes `record: false` so an inbound call is never recorded twice.
export function renderJoinConference(opts: {
  conferenceName: string;
  // Both optional so the supervisor/listen-in and race-fallback callers can opt out; omitting the
  // callback URL cannot silently produce a recording nobody collects.
  record?: boolean;
  recordingStatusCallbackUrl?: string;
}): string {
  const rec =
    opts.record && opts.recordingStatusCallbackUrl
      ? ` record="record-from-answer-dual" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" recordingStatusCallbackMethod="POST"`
      : "";
  return wrapResponse(
    `<Dial${rec}><Conference region="${CONFERENCE_REGION}" beep="false" waitUrl="${RINGBACK_URL}">${escapeXml(opts.conferenceName)}</Conference></Dial>`
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

// Spoken to the answering staff member ONLY, before they are bridged, when their screen showed the
// customer's number rather than the business one. Without it a divert is indistinguishable from a
// personal call until someone speaks, which is how a customer gets answered with "hello?".
//
// Letter-spaced because TTS reads "TCB" as a word, and as short as it can be while still being a
// sentence. The customer is ALREADY in the conference by this point -- handleAgentAnswer redirects
// them in before returning this document -- so every syllable is one they spend still hearing
// ringback after the phone was picked up. That is the same class of defect as the synchronous-AMD
// bug (CLAUDE.md: "the caller keeps hearing ringback for 2-4s after staff answer"), which is why
// this is ~1s and not a fuller announcement naming the caller. Never grow it.
const WORK_CALL_WHISPER = "T C B call.";

export function renderDialAgentIntoConference(opts: {
  conferenceName: string;
  actionUrl: string;
  recordingStatusCallbackUrl: string;
  record?: boolean;
  whisper?: boolean;
}): string {
  // CONFERENCE-level recording, and NOT a <Dial> recording -- deliberately, and the reasoning is on
  // `renderJoinConference` above.
  //
  // A <Dial> recording belongs to every leg that renders this document, and up to two do per call:
  // the original staff leg plus the transfer target on a warm transfer, or the agent leg plus the
  // dialled customer on an outbound softphone call. Both post to the same recording-status callback,
  // `recording_url` is last-write-wins, and half the conversation ends up orphaned in Twilio. That
  // shipped on 2026-09-12 and /code-review caught it the same hour.
  //
  // An INBOUND call is recorded by the caller's own leg instead (see `renderJoinConference`), which
  // is dual-channel and survives transfers -- so the inbound staff-answer path passes
  // `record: false` here and an inbound call is never recorded twice.
  //
  // What is left for this to cover is the outbound softphone flow, where no caller-owned <Dial>
  // exists to hang a recording on. A conference recording is ONE recording however many legs ask for
  // it, so it cannot double up; the cost is that it is mono unless the Console switch works, so
  // those transcripts stay unlabelled and keep Whisper's text. Worth having over no recording, and
  // not worth guessing which leg is which to get labels.
  const rec =
    opts.record === false
      ? ""
      : ` record="record-from-start" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" recordingStatusCallbackMethod="POST"`;
  // The <Say> precedes the <Dial>, so it plays on this leg alone -- the caller is in the conference
  // and cannot hear it.
  return wrapResponse(
    (opts.whisper ? `<Say>${escapeXml(WORK_CALL_WHISPER)}</Say>` : "") +
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

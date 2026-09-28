// Self-hosted ringback tone, shared by the queue-hold ringback and the conference waitUrl.
//
// SELF-HOSTED, NOT TWILIO'S CDN. Twilio's SDK copy (sdk.twilio.com/.../outgoing.mp3) started
// returning HTTP 403 to Twilio's OWN media servers when fetched server-side as a waitUrl / hold
// <Play>, producing error 11200 -> "an application error has occurred" the moment a caller sat
// alone (ringing out / on hold). Do NOT revert to an sdk.twilio.com URL.
//
// AUSTRALIAN, NOT AMERICAN. The file this replaced was a copy of that Twilio SDK asset, which is
// the US ringback: a single continuous 1.41s burst at 440 Hz. Australian callers reported it did
// not sound like a phone ringing, because it isn't -- AU ringback is a warble of 400 + 425 + 450 Hz
// in a distinctive double pulse. Measured before replacing: 440 Hz dominant, one 1.41s burst,
// 0.29s gap. Measured after: 400/425/450 Hz present in equal measure, 440/480 Hz absent.
//
// Synthesised rather than sampled, so it is exact and carries no licensing question:
//   sample rate  8000 Hz mono 16-bit PCM  (the PSTN rate -- no quality lost vs mp3, and Twilio
//                                          downsamples to 8 kHz anyway)
//   tone         sin(400) + sin(425) + sin(450), averaged, 5ms fades to stop the bursts clicking
//   cadence      0.4s on, 0.2s off, 0.4s on, 2.0s off  = exactly one 3.0s AU ring cycle
//   level        tone RMS 0.10 (~-20 dBFS), matched to the 0.085 of the file it replaced so the
//                volume did not jump
//
// The 3.0s length is load-bearing in BOTH consumers, which is why it is one WHOLE cycle:
//   - conference: looped by the TwiML at CONFERENCE_WAIT_URL below. A partial cycle would loop with
//     the wrong gap.
//   - queue hold: rendered as <Play loop="1"> with no wrapping <Gather> (see renderHold), so the
//     document IS one cycle and Twilio re-fetches the waitUrl the instant it ends.
//
// Served from R2 under a versioned-by-name key. /media/* sets `immutable, max-age=1 year`, so an
// updated tone MUST get a NEW filename -- overwriting in place leaves Twilio and Cloudflare serving
// the old audio for months.
export const RINGBACK_URL = "https://tcbvoip.app/media/system/ringback-au.wav";

// The <Conference waitUrl>. NOT the wav itself: Twilio plays whatever a waitUrl returns ONCE and then
// holds the participant in silence ("Once the TwiML document located at the waitUrl runs out of verbs
// to execute, silence will be played"). Pointed straight at the wav from 2026-08-23 -- on the belief
// that "Twilio loops the file itself" -- so an outbound softphone call played ONE 3s ring cycle and
// then dead air until the customer answered (reported 2026-09-28 as "a weird dial, then quiet"), and
// an inbound caller waiting in the conference for the staff leg got the same.
// This URL answers `<Play loop="0">` (renderConferenceRingback). An unbounded loop is correct HERE
// and nowhere near the queue hold document: wait audio stops the moment the conference starts (a
// second participant joins), so nothing needs this document to end. Public and static, like /media/.
export const CONFERENCE_WAIT_URL = "https://tcbvoip.app/twiml/ringback-wait";

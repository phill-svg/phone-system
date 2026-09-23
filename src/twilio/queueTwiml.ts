import type { FlowCommand } from "../ivr/flowEngine";
import { renderFlowCommandsFragment, wrapResponse, escapeXml } from "./flowTwiml";
import { RINGBACK_URL } from "./ringback";

// While a caller waits for staff to be dialed (a ring with no explicit wait node), they hear a
// ringing tone so it sounds like a normal ringing phone rather than hold music. A real "wait node"
// with its own audio/TTS still overrides this. RINGBACK_URL is self-hosted (see ./ringback).

// How many times the ringback tone repeats per hold document. MUST stay finite, and should stay 1.
//
// The hold document is a POLL, not a soundtrack: Twilio only re-fetches the queue's waitUrl once
// this document ENDS, and that is the only way CallSession can hand the caller a <Leave/> and move
// them to the no-answer branch. A <Play loop="0"> means "repeat until the caller hangs up", so
// nesting one here makes the document never end -- the caller is stuck on ringback forever no
// matter what the ring plan decided. That regression shipped once (9dabdd8) and stranded real
// callers: staff legs timed out on schedule at 20s, the ring plan went DONE{no_answer}, and the
// caller still heard 31 more seconds of ringing before giving up.
//
// 1 because the asset is exactly one 3.0s Australian ring cycle (see ./ringback), so one loop is
// one ring. Raising it does not give "more rings" -- it delays the caller's release by 3s per extra
// loop for no audible benefit, since the file already contains its own inter-ring silence.
export const HOLD_RINGBACK_LOOPS = 1;

/**
 * Renders the caller-leg <Enqueue> TwiML: parks the caller in a per-call queue while
 * staff are dialed via outbound REST. Complete TwiML document by itself.
 */
// `prefix` is optional already-rendered TwiML (e.g. a greeting <Play>/<Say>) played once, before
// the caller is enqueued into the hold/ring loop.
export function renderEnqueue(opts: { queueName: string; waitUrl: string; actionUrl: string; prefix?: string }): string {
  return wrapResponse(
    (opts.prefix ?? "") +
      `<Enqueue waitUrl="${opts.waitUrl}" waitUrlMethod="POST" action="${opts.actionUrl}" method="POST">` +
      `${escapeXml(opts.queueName)}</Enqueue>`
  );
}

/**
 * Renders the hold (waitUrl) TwiML the caller hears while queued. `play` is a wait step's
 * announcement, passed only until the caller has heard it once (CallSession.holdDocument); it is
 * followed by a ring cycle inside the same <Gather>, so a key pressed a moment after the message
 * ends ("press 1 now") is still caught rather than lost between documents. Without `play` the
 * caller hears ringback, wrapped in a <Gather> only when the step offers a callback key.
 */
export function renderHold(opts: {
  play: FlowCommand | null;
  baseUrl: string;
  gatherAction: string;
  timeoutSeconds: number;
  // Whether a caller may press a key here for a callback (which key is the wait step's callbackKey,
  // decided in CallSession.handleHoldDigit). Only a wait node sets it; a direct ring never does,
  // which is why the plain-ringback path can drop the <Gather> entirely. `play` is the step's
  // announcement, which CallSession passes only until it has been heard once.
  allowStar?: boolean;
}): string {
  // With custom wait content, play it; otherwise fall back to default hold music so the caller
  // hears something rather than dead air between hold polls.
  const ringback = `<Play loop="${HOLD_RINGBACK_LOOPS}">${RINGBACK_URL}</Play>`;
  const content = opts.play ? renderFlowCommandsFragment([opts.play], { baseUrl: opts.baseUrl }) + ringback : ringback;

  // Plain ringback with no * to catch: emit the tone ALONE, with no wrapping <Gather>.
  //
  // The <Gather>'s only job on this path is capturing a callback star press, and its `timeout` is
  // silence appended AFTER the tone finishes -- which lands inside the ring cadence and stretches
  // the gap between rings. That is what made the hold tone "not sound like a normal ring": the
  // caller heard ring, short gap, ring, long gap. Without the <Gather> the document is exactly one
  // ring cycle, and Twilio re-fetches the waitUrl the moment it ends, so the cadence stays true.
  //
  // This still terminates, which is the property the queue depends on to re-poll and release the
  // caller -- it just returns to the waitUrl handler (handleHoldPoll) instead of the <Gather>
  // action (handleHoldDigit). Both already decide "keep holding vs <Leave/>" the same way.
  if (!opts.play && !opts.allowStar) return wrapResponse(content);

  return wrapResponse(
    // finishOnKey="" -- Twilio's default "#" would end the Gather and post NO digits, which reads as
    // "the announcement played to its end" and stops it replaying for a caller who cut it short.
    `<Gather input="dtmf" numDigits="1" timeout="${opts.timeoutSeconds}" finishOnKey="" ` +
      `actionOnEmptyResult="true" action="${opts.gatherAction}">${content}</Gather>`
  );
}

/**
 * Renders <Leave/> — pulls the caller out of the queue (used when the queue action
 * decides the caller should leave, e.g. to fall through to voicemail).
 */
export function renderLeave(): string {
  return wrapResponse("<Leave/>");
}

/**
 * Renders the "callback_requested" acknowledgement: a polite closing message + hangup.
 * Used after the caller presses star to request a callback (the D1 write is Task 9's job).
 */
export function renderCallbackAck(message: string): string {
  return wrapResponse(`<Say>${escapeXml(message)}</Say><Hangup/>`);
}

import type { FlowCommand } from "../ivr/flowEngine";
import { renderFlowCommandsFragment, wrapResponse, escapeXml } from "./flowTwiml";
import { RINGBACK_URL } from "./ringback";

// While a caller waits for staff to be dialed (a ring with no explicit wait node), they hear a
// ringing tone so it sounds like a normal ringing phone rather than hold music. A real "wait node"
// with its own audio/TTS still overrides this. RINGBACK_URL is self-hosted (see ./ringback).

// How many times the ringback tone repeats per hold document. MUST stay finite.
//
// The hold document is a POLL, not a soundtrack: Twilio only re-fetches the queue's waitUrl (and
// only fires the <Gather> `action` that CallSession.handleHoldDigit uses to decide "keep holding"
// vs <Leave/>) once this document ENDS. A <Play loop="0"> means "repeat until the caller hangs up",
// so nesting one in the <Gather> makes the document never end -- the caller is then stuck listening
// to ringback forever, and the no-answer fall-through to the menu/voicemail can never be delivered
// no matter what the ring plan decided. That regression shipped once (9dabdd8) and stranded real
// callers: staff legs timed out on schedule at 20s, the ring plan went DONE{no_answer}, and the
// caller still heard 31 more seconds of ringing before giving up and hanging up.
//
// The ringback asset is ~1.8s, so this is roughly a 3.6s tone burst per cycle; combined with the
// short trailing <Gather> timeout (see HOLD_RINGBACK_TIMEOUT_SECONDS in CallSession) it bounds how
// long a caller keeps hearing ring after the last staff leg gives up.
// Do NOT set this to 0. The conference ringback is a different case -- there the caller is released
// by the conference join, not by a poll -- so its unbounded loop is fine and lives elsewhere.
export const HOLD_RINGBACK_LOOPS = 2;

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
 * Renders the hold (waitUrl) TwiML the caller hears while queued. Wraps optional hold
 * content (a single FlowCommand, rendered via Task 4's renderer) in a <Gather> so a
 * possible star-press can be captured. When `play` is null (no wait-node content, or the
 * synthesized-minimal-hold case for a ring node with no preceding wait) the <Gather> is
 * empty.
 */
export function renderHold(opts: {
  play: FlowCommand | null;
  baseUrl: string;
  gatherAction: string;
  timeoutSeconds: number;
}): string {
  // With custom wait content, play it; otherwise fall back to default hold music so the caller
  // hears something rather than dead air between hold polls.
  const content = opts.play
    ? renderFlowCommandsFragment([opts.play], { baseUrl: opts.baseUrl })
    : `<Play loop="${HOLD_RINGBACK_LOOPS}">${RINGBACK_URL}</Play>`;
  return wrapResponse(
    `<Gather input="dtmf" numDigits="1" timeout="${opts.timeoutSeconds}" ` +
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

import type { FlowCommand } from "../ivr/flowEngine";
import { renderFlowCommandsFragment, wrapResponse } from "./flowTwiml";

/**
 * Escapes XML special characters (5-entity convention, matching the other TwiML
 * renderers in this codebase). flowTwiml.ts has its own copy but does not export it,
 * so we keep a small local copy here.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Renders the caller-leg <Enqueue> TwiML: parks the caller in a per-call queue while
 * staff are dialed via outbound REST. Complete TwiML document by itself.
 */
export function renderEnqueue(opts: { queueName: string; waitUrl: string; actionUrl: string }): string {
  return wrapResponse(
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
  const content = opts.play
    ? renderFlowCommandsFragment([opts.play], { baseUrl: opts.baseUrl })
    : "";
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
 * Renders the agent/staff-leg TwiML: bridges the answering staff leg into the caller's
 * queue and records the resulting conversation.
 */
export function renderDialIntoQueue(opts: {
  queueName: string;
  actionUrl: string;
  recordingStatusCallbackUrl: string;
}): string {
  return wrapResponse(
    `<Dial action="${opts.actionUrl}" method="POST" record="record-from-answer-dual" ` +
      `recordingStatusCallback="${opts.recordingStatusCallbackUrl}" recordingStatusCallbackMethod="POST">` +
      `<Queue>${escapeXml(opts.queueName)}</Queue>` +
      `</Dial>`
  );
}

/**
 * Renders the "callback_requested" acknowledgement: a polite closing message + hangup.
 * Used after the caller presses star to request a callback (the D1 write is Task 9's job).
 */
export function renderCallbackAck(message: string): string {
  return wrapResponse(`<Say>${escapeXml(message)}</Say><Hangup/>`);
}

import { DurableObject } from "cloudflare:workers";
import { advanceFlow, walkFromNode, type FlowCommand } from "../ivr/flowEngine";
import { renderFlowTwiml, renderFlowCommandsFragment, wrapResponse, escapeXml } from "../twilio/flowTwiml";
import {
  renderEnqueue,
  renderHold,
  renderLeave,
  renderCallbackAck,
} from "../twilio/queueTwiml";
import { resolveRingTargets, type RingNodeTarget } from "../dial/ringQueue";
import { demoEmails } from "../demo";
import {
  reduceRingPlan,
  type RingPlanState,
  type RingStrategy,
} from "../dial/ringPlan";
import { createOutboundCall, cancelCall, redirectCall, hangupCall } from "../twilio/restClient";
import { cleanupLoneConference } from "../twilio/conferenceClient";
import { renderDialAgentIntoConference, renderJoinConference } from "../twilio/conferenceTwiml";
import { appendWebhookSecret } from "../twilio/webhookAuth";
import { getBusinessHours, getRecordingEnabled } from "../db/settings";
import { createCallbackRequest } from "../db/callbackRequests";
import { appendCallEvent, parseRecordingDuration } from "../db/calls";
import { getAudioAsset } from "../db/audioAssets";
import { recordCallLeg } from "../db/callLegs";
import { isWithinBusinessHours } from "../ivr/businessHours";
import { notifyMissedCall, notifyVoicemail } from "../api/push";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_WEBHOOK_SECRET?: string;
  TWILIO_FROM_NUMBER: string;
  DEMO_ACCOUNT_EMAILS?: string;
};

// Config shape stored on a `ring` node.
type RingConfig = {
  target: RingNodeTarget;
  strategy: RingStrategy;
  timeoutSeconds: number;
  noAnswerNextNodeId: string;
};

// DO-storage shape tracking a live dial-out for the current call.
type ActiveRing = {
  ringNodeId: string;
  play: FlowCommand | null;
  allowCallbackStar: boolean;
  ringConfig: RingConfig;
  ringPlanState: RingPlanState;
  attemptSids: string[];
  // When a greeting must play to the caller BEFORE staff ring, the initial batch of numbers is
  // stashed here and dialed on the first hold-poll (i.e. once the caller has heard the greeting)
  // instead of up-front. Cleared once dialed.
  pendingDial?: string[];
};

type IvrPosition = { nodeId: string; attempt: number };

type WalkResult = {
  nextNodeId: string;
  attempt: number;
  commands: FlowCommand[];
  capturedInput?: { nodeId: string; value: string };
};

// ---- Inbound event shapes (mirror the JSON bodies worker.ts forwards) ----

type MainWebhookEvent = {
  kind?: undefined;
  callSid: string;
  from: string;
  to: string;
  digits: string | null;
  recordingUrl: string | null;
  recordingSid: string | null;
  recordingDuration: string | null;
  webhookUrl: string;
};

type HoldPollEvent = { kind: "hold_poll"; callSid: string; webhookUrl: string };
type HoldDigitEvent = { kind: "hold_digit"; callSid: string; digits: string | null; webhookUrl: string };
type QueueLeftEvent = { kind: "queue_left"; callSid: string; queueResult: string | null; webhookUrl: string };
type AgentAnswerEvent = {
  kind: "agent_answer";
  callSid: string;
  agentCallSid: string;
  webhookUrl: string;
  // Twilio's synchronous-AMD classification of the answering leg ("human" | "machine_start" |
  // "machine_end_beep" | "machine_end_silence" | "machine_end_other" | "fax" | "unknown"). Only
  // present when the leg was dialed with MachineDetection enabled (the pstn mobile leg -- see
  // dialStaff). Undefined for softphone legs, which never carry AMD.
  answeredBy?: string;
};
type AgentStatusEvent = {
  kind: "agent_status";
  callSid: string;
  agentCallSid: string;
  callStatus: string | null;
  webhookUrl: string;
};

// Async AMD verdict for a pstn mobile leg, delivered out-of-band well after the legs bridged.
type AmdStatusEvent = {
  kind: "amd_status";
  callSid: string;
  agentCallSid: string;
  answeredBy: string | null;
  webhookUrl: string;
};
// The caller leg, re-pointed here after we pulled it out of a conference a machine had answered.
type AmdFallthroughEvent = { kind: "amd_fallthrough"; callSid: string; webhookUrl: string };

type AnyEvent =
  | MainWebhookEvent
  | HoldPollEvent
  | HoldDigitEvent
  | QueueLeftEvent
  | AgentAnswerEvent
  | AgentStatusEvent
  | AmdStatusEvent
  | AmdFallthroughEvent;

// Trailing <Gather> timeout on a hold document that carries a WAIT NODE'S OWN audio/TTS. This is
// silence appended after that content, so it also sets how often the announcement repeats -- keep
// it long enough not to nag the caller.
const HOLD_CONTENT_TIMEOUT_SECONDS = 20;

// Trailing <Gather> timeout on a default-ringback hold document. Together with HOLD_RINGBACK_LOOPS
// this is the poll period: the caller cannot leave the queue until the document ends, so it bounds
// how long they keep hearing ringback after the ring plan has already given up (~2 x 1.8s of tone
// + this, so ~5s). Kept short deliberately -- a caller who has already waited out a 20s ring should
// reach the menu promptly, and a * callback press is still caught during the tone itself.
const HOLD_RINGBACK_TIMEOUT_SECONDS = 1;
const AGENT_FAILURE_STATUSES = new Set(["busy", "no-answer", "failed", "canceled"]);

export class CallSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as AnyEvent;
    try {
      if (body.kind === "hold_poll") return await this.handleHoldPoll(body);
      if (body.kind === "hold_digit") return await this.handleHoldDigit(body);
      if (body.kind === "queue_left") return await this.handleQueueLeft(body);
      if (body.kind === "agent_answer") return await this.handleAgentAnswer(body);
      if (body.kind === "agent_status") return await this.handleAgentStatus(body);
      if (body.kind === "amd_status") return await this.handleAmdStatus(body);
      if (body.kind === "amd_fallthrough") return await this.handleAmdFallthrough(body);
      return await this.handleMainWebhook(body);
    } catch (err) {
      // A misconfigured flow (e.g. a node pointing at an id that doesn't exist -- allowed by
      // design, since flows are built incrementally) throws here rather than at save time. A
      // raw uncaught exception becomes a bare 500 to Twilio, which plays a generic, jarring
      // "application error" message with no way to recover the call. Fail gracefully instead:
      // agent_status expects a plain 200 with no TwiML body; every other kind renders TwiML to
      // a live caller/agent leg, so give them a real spoken message and a clean hangup.
      console.log("CALLSESSION_ERROR", JSON.stringify({ kind: body.kind ?? "main_webhook", error: err instanceof Error ? err.message : String(err) }));
      if (body.kind === "agent_status" || body.kind === "amd_status") return new Response("ok", { status: 200 });
      return this.xml(wrapResponse("<Say>Sorry, we're experiencing a technical issue. Please try again shortly.</Say><Hangup/>"));
    }
  }

  // -------------------------------------------------------------------------
  // Main inbound webhook (the caller leg): first ENTER, subsequent gather
  // turns, and the voicemail <Record> action callback (recordingUrl present).
  // -------------------------------------------------------------------------
  private async handleMainWebhook(body: MainWebhookEvent): Promise<Response> {
    const { callSid, from, to, digits, webhookUrl } = body;
    const origin = new URL(webhookUrl).origin;

    // (a) Voicemail <Record> action callback lands here on the SAME route/CallSid.
    if (body.recordingUrl) {
      const nodeId = await this.ctx.storage.get<string>("awaitingVoicemailNodeId");
      let mailboxLabel: string | null = null;
      if (nodeId) {
        const config = await this.loadNodeConfig(nodeId);
        mailboxLabel = (config.mailboxLabel as string | undefined) ?? null;
      }
      await this.env.DB.prepare(
        "UPDATE calls SET status = 'completed', ended_at = ?, recording_url = ?, recording_sid = ?, recording_duration = COALESCE(?, recording_duration), mailbox_label = ? WHERE id = ?"
      )
        .bind(
          Date.now(),
          body.recordingUrl,
          body.recordingSid,
          parseRecordingDuration(body.recordingDuration),
          mailboxLabel,
          callSid
        )
        .run();
      await this.logEvent(callSid, "voicemail_left", { mailboxLabel, recordingSid: body.recordingSid });
      try {
        await notifyVoicemail(this.env.DB, from);
      } catch {
        /* notifications are best-effort */
      }
      return this.xml(wrapResponse("<Say>Thanks, goodbye.</Say><Hangup/>"));
    }

    const stored = await this.ctx.storage.get<IvrPosition>("ivrPosition");

    // (b) First-ever webhook for this call.
    if (!stored) {
      const isAfterHours = !isWithinBusinessHours(await getBusinessHours(this.env.DB), new Date());
      await this.env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours, direction) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(callSid, from, to, Date.now(), isAfterHours ? 1 : 0, "inbound")
        .run();
      await this.logEvent(callSid, "call_started", { from, to, afterHours: isAfterHours });

      // Route after-hours callers into the dedicated "after_hours" flow (emergency ring /
      // voicemail) instead of the in-hours "main" menu. If the "after_hours" flow is
      // missing/misconfigured (no entry node), fall back to "main" so a live call still connects
      // rather than erroring out.
      const entryFlow = isAfterHours ? "after_hours" : "main";
      let result: WalkResult;
      try {
        result = await advanceFlow(this.env.DB, entryFlow, null, { type: "ENTER" }, isAfterHours, 0);
      } catch (err) {
        if (entryFlow === "main") throw err;
        console.log("AFTER_HOURS_FLOW_FALLBACK", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        result = await advanceFlow(this.env.DB, "main", null, { type: "ENTER" }, isAfterHours, 0);
      }
      return this.xml(await this.applyWalkResult(callSid, result, isAfterHours, origin));
    }

    // (c) Continuing from a gather node (digit or timeout/invalid). The flow name is only used
    // for ENTER; gather continuations resolve by the stored node id, so "main" is fine here even
    // for a call that entered via "after_hours".
    if (digits) await this.logEvent(callSid, "menu_selection", { digit: digits });
    const isAfterHours = !isWithinBusinessHours(await getBusinessHours(this.env.DB), new Date());
    const result = await advanceFlow(
      this.env.DB,
      "main",
      stored.nodeId,
      digits ? { type: "DIGIT", digit: digits } : { type: "TIMEOUT_OR_INVALID" },
      isAfterHours,
      stored.attempt
    );
    return this.xml(await this.applyWalkResult(callSid, result, isAfterHours, origin));
  }

  // -------------------------------------------------------------------------
  // Shared interpretation of an advanceFlow / walkFromNode result. Returns the
  // TwiML body string for the caller leg.
  // -------------------------------------------------------------------------
  private async applyWalkResult(
    callSid: string,
    walkResult: WalkResult,
    isAfterHours: boolean,
    origin: string
  ): Promise<string> {
    // An "input" node the caller just completed: record the digits they entered before the flow
    // moves on to the next node.
    if (walkResult.capturedInput) {
      await this.logEvent(callSid, "input_received", {
        node: walkResult.capturedInput.nodeId,
        value: walkResult.capturedInput.value,
      });
    }

    // Redirect node: forward the caller to a fixed external number and bridge.
    if (walkResult.commands.some((c) => c.type === "REDIRECT")) {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?")
        .bind(walkResult.nextNodeId, callSid)
        .run();
      await this.logEvent(callSid, "redirected", { node: walkResult.nextNodeId });
      const resolved = await this.resolveAudioCommands(walkResult.commands);
      return renderFlowTwiml(resolved, { baseUrl: origin });
    }

    const hasEnqueue = walkResult.commands.some((c) => c.type === "ENQUEUE");
    const hasDialHandoff = walkResult.commands.some((c) => c.type === "DIAL_HANDOFF");

    if (hasEnqueue || hasDialHandoff) {
      return this.startRing(callSid, walkResult, hasEnqueue, isAfterHours, origin);
    }

    if (walkResult.commands.some((c) => c.type === "VOICEMAIL_HANDOFF")) {
      const voicemailNodeId = walkResult.nextNodeId;
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?")
        .bind(voicemailNodeId, callSid)
        .run();
      await this.ctx.storage.put("awaitingVoicemailNodeId", voicemailNodeId);
      const resolvedVoicemailCommands = await this.resolveAudioCommands(walkResult.commands);
      const fragment = renderFlowCommandsFragment(resolvedVoicemailCommands, { baseUrl: origin });
      // These URLs carry two query params (callSid + whsec/vm), so the joining "&" MUST be XML-escaped
      // to "&amp;" — an unescaped "&" in a TwiML attribute is a document parse error ("application
      // error") at Twilio. (The single-param URLs elsewhere don't hit this, which is why it lurked.)
      //
      // Voicemail transcription now uses Whisper (via the recording-status → transcribeCallRecording
      // path, ?vm=1 so it lands in `transcription`), NOT Twilio's `transcribe="true"` — cheaper,
      // better, and consistent with answered-call transcripts. The `recordingStatusCallback` also
      // means the voicemail recording gets stored + becomes playable.
      const recordingStatusCb = appendWebhookSecret(`${origin}/webhooks/twilio/recording-status?callSid=${callSid}&vm=1`, this.env.TWILIO_WEBHOOK_SECRET);
      const recordAction = appendWebhookSecret(`${origin}/webhooks/twilio`, this.env.TWILIO_WEBHOOK_SECRET);
      const record = `<Record action="${escapeXml(recordAction)}" method="POST" maxLength="120" timeout="5" playBeep="true" recordingStatusCallback="${escapeXml(recordingStatusCb)}" recordingStatusCallbackEvent="completed"/>`;
      return wrapResponse(fragment + record);
    }

    // Ordinary gather turn (or terminal hangup): patch the GATHER action to the
    // main webhook so the caller's next digit comes back to this DO.
    await this.ctx.storage.put("ivrPosition", {
      nodeId: walkResult.nextNodeId,
      attempt: walkResult.attempt,
    });
    const mainWebhookUrl = appendWebhookSecret(`${origin}/webhooks/twilio`, this.env.TWILIO_WEBHOOK_SECRET);
    const patched = walkResult.commands.map((c) =>
      c.type === "GATHER" || c.type === "INPUT" ? { ...c, action: mainWebhookUrl } : c
    );
    const resolved = await this.resolveAudioCommands(patched);
    return renderFlowTwiml(resolved, { baseUrl: origin });
  }

  // -------------------------------------------------------------------------
  // Resolve the ring node reached (via wait-node ENQUEUE or direct DIAL_HANDOFF),
  // dial staff, and enqueue the caller. Returns the caller-leg TwiML.
  // -------------------------------------------------------------------------
  private async startRing(
    callSid: string,
    walkResult: WalkResult,
    viaWait: boolean,
    isAfterHours: boolean,
    origin: string
  ): Promise<string> {
    let ringNodeId: string;
    let play: FlowCommand | null;
    let allowCallbackStar: boolean;

    if (viaWait) {
      // nextNodeId is the WAIT node's own id; load its config for the real ring node id + hold content.
      const waitConfig = await this.loadNodeConfig(walkResult.nextNodeId);
      ringNodeId = waitConfig.nextNodeId as string;
      play = await this.playFromConfig(waitConfig);
      allowCallbackStar = waitConfig.allowCallbackStar === true;
    } else {
      // nextNodeId IS the ring node itself; no preceding wait → no hold content, no callback star.
      ringNodeId = walkResult.nextNodeId;
      play = null;
      allowCallbackStar = false;
    }

    const ringConfig = (await this.loadNodeConfig(ringNodeId)) as unknown as RingConfig;

    // Greeting/prompt accumulated on the way to a DIRECT ring (e.g. business_hours -> play greeting
    // -> ring) must play ONCE before anything else -- whether we go on to ring staff OR (nobody
    // available) fall straight through to the next node. Computed up-front so BOTH paths include it.
    // Skipped for the viaWait path, whose PLAY is the wait node's hold content and is already spoken
    // during the hold loop (don't double-play).
    let greetingPrefix = "";
    if (!viaWait) {
      const greetingCommands = walkResult.commands.filter((c) => c.type === "PLAY");
      if (greetingCommands.length > 0) {
        const resolved = await this.resolveAudioCommands(greetingCommands);
        greetingPrefix = renderFlowCommandsFragment(resolved, { baseUrl: origin });
      }
    }

    const now = new Date();
    const numbers = await resolveRingTargets(this.env.DB, ringConfig.target, now, demoEmails(this.env));

    // Zero on-call numbers: skip the ring/enqueue dance and continue the flow from the ring node's
    // noAnswerNextNodeId (e.g. nobody on call → voicemail/menu) -- but still play the greeting first
    // (inject it right after the opening <Response> of the fall-through document).
    if (numbers.length === 0) {
      const fallthrough = await this.renderNoAnswerFallthrough(callSid, ringConfig.noAnswerNextNodeId, isAfterHours, origin);
      // Deliberately string-level, not command composition: the fallthrough can itself be ANY shape
      // (redirect, hangup, gather, voicemail, or -- via a wait node -- another nested ring/enqueue).
      // Composing at the FlowCommand level would have to thread this greeting through every one of
      // those branches, and the nested-ring case is a proven trap: a wait node's own commands are
      // `[holdContentPlay?, ENQUEUE]` (flowEngine.ts), and startRing skips PLAY-filtering entirely on
      // that path (viaWait) to avoid double-playing the hold content -- so a composed-in greeting would
      // silently vanish. Splicing the already-rendered XML has no such blind spot. Function replacer:
      // a plain string here would interpret $&, $', $` and $$ inside admin-authored greeting text as
      // replacement patterns and corrupt the TwiML.
      return greetingPrefix ? fallthrough.replace("<Response>", () => "<Response>" + greetingPrefix) : fallthrough;
    }

    const { state: ringPlanState, commands: ringCommands } = reduceRingPlan(null, {
      type: "START",
      strategy: ringConfig.strategy,
      numbers,
    });

    // Flatten the ring-plan commands into the concrete list of numbers to dial for this batch
    // (one for DIAL_NEXT/cascade, all for DIAL_ALL/simultaneous), preserving ring-list order.
    const numbersToDial: string[] = [];
    for (const command of ringCommands) {
      if (command.type === "DIAL_NEXT") numbersToDial.push(command.number);
      else if (command.type === "DIAL_ALL") numbersToDial.push(...command.numbers);
    }

    // If there's a greeting to play FIRST (direct ring), DEFER dialing staff until the caller has
    // actually heard it — otherwise the staff phones ring while the caller is still on the welcome
    // message (and whoever answers catches the caller mid-recording). The deferred dial runs on the
    // first hold-poll (waitUrl), which Twilio fetches right after the greeting <Play> finishes.
    // Without a greeting, dial immediately (original behaviour) via the shared dialBatch helper.
    let attemptSids: string[] = [];
    if (!greetingPrefix) {
      const sids = await this.dialBatch(numbersToDial, callSid, origin, ringConfig.timeoutSeconds);
      if (!sids) {
        return this.renderNoAnswerFallthrough(callSid, ringConfig.noAnswerNextNodeId, isAfterHours, origin);
      }
      attemptSids = sids;
    }

    const activeRing: ActiveRing = {
      ringNodeId,
      play,
      allowCallbackStar,
      ringConfig,
      ringPlanState,
      attemptSids,
      pendingDial: greetingPrefix ? numbersToDial : undefined,
    };
    await this.ctx.storage.put("activeRing", activeRing);
    if (!greetingPrefix) await this.logEvent(callSid, "ring_started", { targets: numbers.length, strategy: ringConfig.strategy });

    return renderEnqueue({
      queueName: callSid,
      waitUrl: appendWebhookSecret(`${origin}/webhooks/twilio/hold`, this.env.TWILIO_WEBHOOK_SECRET),
      actionUrl: appendWebhookSecret(`${origin}/webhooks/twilio/queue-left`, this.env.TWILIO_WEBHOOK_SECRET),
      prefix: greetingPrefix,
    });
  }

  // -------------------------------------------------------------------------
  // Shared no-answer fallthrough: walk the flow from a ring node's noAnswerNextNodeId and render
  // the resulting caller-leg TwiML. Used by startRing (empty ring list, and mid-batch dial
  // failure) and handleQueueLeft (cascade/simultaneous exhaustion). Callers own any activeRing
  // deletion; this helper only produces the TwiML body.
  // -------------------------------------------------------------------------
  private async renderNoAnswerFallthrough(
    callSid: string,
    noAnswerNextNodeId: string,
    isAfterHours: boolean,
    origin: string
  ): Promise<string> {
    const result = await walkFromNode(this.env.DB, noAnswerNextNodeId, isAfterHours);
    return this.applyWalkResult(callSid, result, isAfterHours, origin);
  }

  // -------------------------------------------------------------------------
  // Caller-leg hold poll (waitUrl loop): keep holding while dialing, else leave.
  // -------------------------------------------------------------------------
  private async handleHoldPoll(body: HoldPollEvent): Promise<Response> {
    const origin = new URL(body.webhookUrl).origin;
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");

    // Deferred-dial: the greeting has now finished (the caller is in the hold loop), so THIS is when
    // we actually ring staff for a greeting-first ring. DO handlers are serialized, so a subsequent
    // hold-poll can't race this — pendingDial is cleared before the next poll runs.
    if (activeRing && activeRing.pendingDial && activeRing.pendingDial.length > 0) {
      await this.performDeferredDial(activeRing, body.callSid, origin);
      const updated = await this.ctx.storage.get<ActiveRing>("activeRing");
      if (updated && updated.ringPlanState.name === "DIALING") {
        return this.xml(this.renderHoldFor(updated, origin));
      }
      // Dial failed -> leave the queue so the caller falls through to the no-answer node.
      return this.xml(renderLeave());
    }

    if (activeRing && activeRing.ringPlanState.name === "DIALING") {
      return this.xml(this.renderHoldFor(activeRing, origin));
    }
    return this.xml(renderLeave());
  }

  // Rings the deferred initial batch (greeting-first ring) once the caller has heard the greeting.
  // On failure it cancels any placed legs and marks the ring DONE{no_answer} so the caller leaves
  // the queue into the no-answer fall-through (mirrors startRing's immediate-dial failure path).
  private async performDeferredDial(activeRing: ActiveRing, callSid: string, origin: string): Promise<void> {
    const numbersToDial = activeRing.pendingDial ?? [];
    const sids = await this.dialBatch(numbersToDial, callSid, origin, activeRing.ringConfig.timeoutSeconds);
    if (!sids) {
      activeRing.pendingDial = undefined;
      activeRing.attemptSids = [];
      activeRing.ringPlanState = { name: "DONE", outcome: "no_answer" };
      await this.ctx.storage.put("activeRing", activeRing);
      return;
    }
    activeRing.attemptSids = sids;
    activeRing.pendingDial = undefined;
    await this.ctx.storage.put("activeRing", activeRing);
    await this.logEvent(callSid, "ring_started", { targets: sids.length, strategy: activeRing.ringConfig.strategy });
  }

  // Dials each number in order, in its own try/catch. If any create-call throws part-way through a
  // multi-number simultaneous batch, the earlier legs are REAL ringing Twilio calls -- cancel every
  // leg already created and return null so the caller can fall through to the no-answer path instead
  // of leaving live-but-orphaned legs ringing. Shared by startRing's immediate-dial branch and
  // performDeferredDial's greeting-first branch so the failure/rollback behavior can't drift between
  // them.
  private async dialBatch(numbers: string[], callSid: string, origin: string, timeoutSeconds: number): Promise<string[] | null> {
    const attemptSids: string[] = [];
    for (const number of numbers) {
      try {
        attemptSids.push(await this.dialStaff(number, callSid, origin, timeoutSeconds));
      } catch (err) {
        // Swallowing this silently once hid a credentials outage for a full day -- always log it.
        console.log("DIAL_STAFF_FAILED", JSON.stringify({ number, error: err instanceof Error ? err.message : String(err) }));
        for (const sid of attemptSids) {
          try {
            await this.cancelStaff(sid);
          } catch {
            /* leg may already be torn down; ignore */
          }
        }
        return null;
      }
    }
    return attemptSids;
  }

  // -------------------------------------------------------------------------
  // Caller-leg hold digit: star = callback request (if allowed), else keep holding.
  // -------------------------------------------------------------------------
  private async handleHoldDigit(body: HoldDigitEvent): Promise<Response> {
    const origin = new URL(body.webhookUrl).origin;
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");
    if (!activeRing) return this.xml(renderLeave());

    if (body.digits === "*" && activeRing.allowCallbackStar && activeRing.ringPlanState.name === "DIALING") {
      const { state } = reduceRingPlan(activeRing.ringPlanState, { type: "CALLBACK_STAR_PRESSED" });
      for (const sid of activeRing.attemptSids) {
        await this.cancelStaff(sid);
      }
      activeRing.ringPlanState = state;
      activeRing.attemptSids = [];
      await this.ctx.storage.put("activeRing", activeRing);
      return this.xml(renderLeave());
    }

    if (activeRing.ringPlanState.name === "DIALING") {
      return this.xml(this.renderHoldFor(activeRing, origin));
    }
    return this.xml(renderLeave());
  }

  // -------------------------------------------------------------------------
  // Caller-leg queue action (caller left the queue): branch on our own tracked
  // outcome, which is more precise than Twilio's QueueResult.
  // -------------------------------------------------------------------------
  private async handleQueueLeft(body: QueueLeftEvent): Promise<Response> {
    const origin = new URL(body.webhookUrl).origin;
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");
    if (!activeRing) return this.xml(wrapResponse("<Hangup/>"));

    const state = activeRing.ringPlanState;
    const outcome = state.name === "DONE" ? state.outcome : null;

    if (outcome === "bridged") {
      // This fires as the Enqueue action's "redirected" QueueResult, right as -- or possibly racing
      // with -- our own REST redirect (in handleAgentAnswer) sending this same caller leg to
      // /webhooks/twilio/join-conference. Twilio's docs don't specify which response wins that race,
      // so render the same conference-join TwiML here too: if the REST redirect wins, this response
      // is simply discarded; if this response is what Twilio actually applies, the caller still ends
      // up in the right conference instead of being hung up. Do NOT touch status/ended_at here -- the
      // call is just starting to bridge, not ending; /webhooks/twilio/status (guarded by
      // `ended_at IS NULL`) is the authoritative source for the real completion time, and writing
      // ended_at here pre-empted it, which is why D1 previously recorded bridged calls as lasting
      // only a few seconds instead of their real duration.
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?")
        .bind(activeRing.ringNodeId, body.callSid)
        .run();
      await this.ctx.storage.delete("activeRing");
      return this.xml(renderJoinConference({ conferenceName: body.callSid }));
    }

    if (outcome === "callback_requested") {
      const row = await this.env.DB.prepare("SELECT caller_number FROM calls WHERE id = ?")
        .bind(body.callSid)
        .first<{ caller_number: string }>();
      await createCallbackRequest(this.env.DB, {
        callId: body.callSid,
        callerNumber: row?.caller_number ?? "",
      });
      await this.env.DB.prepare("UPDATE calls SET status = 'completed', ended_at = ? WHERE id = ?")
        .bind(Date.now(), body.callSid)
        .run();
      await this.logEvent(body.callSid, "callback_requested", { callerNumber: row?.caller_number ?? null });
      await this.ctx.storage.delete("activeRing");
      return this.xml(renderCallbackAck("Thanks, we'll call you back soon."));
    }

    // no_answer, OR the caller hung up mid-ring (plan still DIALING with outstanding legs).
    //
    // If the caller abandoned while staff were still being dialed, cancel every outstanding staff
    // leg so their phones stop ringing into a now-dead queue. (The Enqueue `action` webhook fires
    // on caller hangup too, which is why we can cancel here without routing /status through the DO.)
    const abandonedMidRing =
      activeRing.ringPlanState.name === "DIALING" && activeRing.attemptSids.length > 0;
    if (abandonedMidRing) {
      for (const sid of activeRing.attemptSids) {
        try {
          await this.cancelStaff(sid);
        } catch {
          /* leg may already be torn down; ignore */
        }
      }
    }
    await this.logEvent(body.callSid, abandonedMidRing ? "caller_hung_up" : "no_answer");
    try {
      const row = await this.env.DB.prepare("SELECT caller_number FROM calls WHERE id = ?")
        .bind(body.callSid)
        .first<{ caller_number: string }>();
      if (row?.caller_number) await notifyMissedCall(this.env.DB, row.caller_number);
    } catch {
      /* notifications are best-effort */
    }
    await this.ctx.storage.delete("activeRing");
    const isAfterHours = !isWithinBusinessHours(await getBusinessHours(this.env.DB), new Date());
    return this.xml(
      await this.renderNoAnswerFallthrough(body.callSid, activeRing.ringConfig.noAnswerNextNodeId, isAfterHours, origin)
    );
  }

  // -------------------------------------------------------------------------
  // Staff-leg answer: a staff member picked up. Cancel other attempts (simultaneous
  // strategy), then bridge the two legs into a real Twilio Conference: REST-redirect the
  // caller's already-enqueued leg into /webhooks/twilio/join-conference, and render this
  // (the agent's) leg's own answer-webhook response to join the same Conference.
  // -------------------------------------------------------------------------
  private async handleAgentAnswer(body: AgentAnswerEvent): Promise<Response> {
    // Synchronous AMD result (pstn mobile leg only -- see dialStaff). A machine/fax answer means a
    // staff member's personal carrier voicemail (or a fax tone) picked up, not a human -- hang up
    // THIS leg only, without cancelling sibling attempts (never touch CANCEL_OTHER_ATTEMPTS/bridge
    // logic below). Ambiguous/human results ("human", "unknown", undefined for AMD-less legs) fall
    // through to the bridge below -- never drop a real call on an ambiguous classification.
    //
    // We must advance the ring plan's failure bookkeeping HERE, synchronously, rather than relying
    // on this leg's later agent-status callback: since Twilio only reports terminal CallStatus
    // "completed" for a leg that was actually answered (AMD requires exactly that) and then ended
    // -- never "no-answer"/"busy"/"failed"/"canceled" -- and handleAgentStatus's cascade/exhaustion
    // advancement is gated on AGENT_FAILURE_STATUSES, which does NOT include "completed". Without
    // this, a machine-answered leg would never be removed from attemptSids, so a cascade would
    // never dial the next number and a simultaneous ring would never reach ALL_ATTEMPTS_EXHAUSTED
    // -- the no-answer -> business-voicemail fallthrough would silently never fire.
    if (body.answeredBy && (body.answeredBy.startsWith("machine") || body.answeredBy === "fax")) {
      await this.logEvent(body.callSid, "mobile_machine_answered", { agentCallSid: body.agentCallSid });
      const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");
      if (activeRing && activeRing.ringPlanState.name === "DIALING" && activeRing.attemptSids.includes(body.agentCallSid)) {
        const origin = new URL(body.webhookUrl).origin;
        await this.advanceRingPlanOnFailedAttempt(activeRing, body.agentCallSid, body.callSid, origin);
      }
      return this.xml(wrapResponse("<Hangup/>"));
    }

    const origin = new URL(body.webhookUrl).origin;
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");

    if (activeRing && activeRing.ringPlanState.name === "DIALING") {
      const { state, commands } = reduceRingPlan(activeRing.ringPlanState, { type: "ATTEMPT_ANSWERED" });
      if (commands.some((c) => c.type === "CANCEL_OTHER_ATTEMPTS")) {
        for (const sid of activeRing.attemptSids) {
          if (sid !== body.agentCallSid) await this.cancelStaff(sid);
        }
      }
      activeRing.ringPlanState = state;
      await this.ctx.storage.put("activeRing", activeRing);
    }
    await this.logEvent(body.callSid, "answered", { agentCallSid: body.agentCallSid });

    await redirectCall(
      this.env.TWILIO_ACCOUNT_SID,
      this.env.TWILIO_AUTH_TOKEN,
      body.callSid,
      appendWebhookSecret(`${origin}/webhooks/twilio/join-conference?conf=${body.callSid}`, this.env.TWILIO_WEBHOOK_SECRET)
    );

    const record = await getRecordingEnabled(this.env.DB);
    return this.xml(
      renderDialAgentIntoConference({
        conferenceName: body.callSid,
        actionUrl: appendWebhookSecret(`${origin}/webhooks/twilio/agent-status?callSid=${body.callSid}`, this.env.TWILIO_WEBHOOK_SECRET),
        recordingStatusCallbackUrl: appendWebhookSecret(`${origin}/webhooks/twilio/recording-status?callSid=${body.callSid}`, this.env.TWILIO_WEBHOOK_SECRET),
        record,
      })
    );
  }

  // -------------------------------------------------------------------------
  // Async AMD verdict for a pstn mobile leg. Because detection runs in the background (so the
  // caller isn't left listening to ringback while it decides), this lands 2-4s AFTER the legs
  // already bridged -- so a "machine" verdict means the caller is currently listening to a staff
  // member's personal carrier voicemail greeting, and we have to undo the bridge.
  // -------------------------------------------------------------------------
  private async handleAmdStatus(body: AmdStatusEvent): Promise<Response> {
    const answeredBy = body.answeredBy ?? "";
    // Only a confirmed machine/fax tears anything down. "human" and "unknown" leave the call
    // exactly as it is -- never drop a real conversation on an ambiguous classification.
    if (!(answeredBy.startsWith("machine") || answeredBy === "fax")) {
      return new Response("ok", { status: 200 });
    }
    await this.logEvent(body.callSid, "mobile_machine_answered", { agentCallSid: body.agentCallSid, answeredBy });

    const origin = new URL(body.webhookUrl).origin;
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");

    // Verdict beat the bridge (still DIALING): the simple pre-bridge path -- drop this leg and let
    // the ring plan carry on to the next number, or to no-answer exhaustion.
    if (activeRing && activeRing.ringPlanState.name === "DIALING" && activeRing.attemptSids.includes(body.agentCallSid)) {
      await this.advanceRingPlanOnFailedAttempt(activeRing, body.agentCallSid, body.callSid, origin);
      try {
        await hangupCall(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_AUTH_TOKEN, body.agentCallSid);
      } catch {
        /* leg already gone */
      }
      return new Response("ok", { status: 200 });
    }

    // Normal path: already bridged. ORDER MATTERS -- pull the CALLER out of the conference first,
    // then hang up the voicemail leg. Doing it the other way round fires the voicemail leg's
    // agent-status, whose cleanupLoneConference ends any conference with <=1 participant left --
    // which at that moment is the caller, so the rescue would hang up the very person we're saving.
    try {
      await redirectCall(
        this.env.TWILIO_ACCOUNT_SID,
        this.env.TWILIO_AUTH_TOKEN,
        body.callSid,
        appendWebhookSecret(`${origin}/webhooks/twilio/amd-fallthrough?callSid=${body.callSid}`, this.env.TWILIO_WEBHOOK_SECRET)
      );
    } catch {
      /* caller already hung up -- nothing left to rescue */
    }
    try {
      await hangupCall(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_AUTH_TOKEN, body.agentCallSid);
    } catch {
      /* voicemail leg already ended */
    }
    return new Response("ok", { status: 200 });
  }

  // The caller leg, re-pointed here after being rescued out of a machine-answered conference.
  // Continues the flow from the ring node's no-answer branch, exactly as an unanswered ring would,
  // so the caller reaches BUSINESS voicemail instead of a staff member's personal one.
  // -------------------------------------------------------------------------
  private async handleAmdFallthrough(body: AmdFallthroughEvent): Promise<Response> {
    const origin = new URL(body.webhookUrl).origin;
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");
    await this.ctx.storage.delete("activeRing");
    if (!activeRing) return this.xml(wrapResponse("<Hangup/>"));

    await this.logEvent(body.callSid, "no_answer", { reason: "mobile_voicemail_answered" });
    try {
      const row = await this.env.DB.prepare("SELECT caller_number FROM calls WHERE id = ?")
        .bind(body.callSid)
        .first<{ caller_number: string }>();
      if (row?.caller_number) await notifyMissedCall(this.env.DB, row.caller_number);
    } catch {
      /* notifications are best-effort */
    }
    const isAfterHours = !isWithinBusinessHours(await getBusinessHours(this.env.DB), new Date());
    return this.xml(
      await this.renderNoAnswerFallthrough(body.callSid, activeRing.ringConfig.noAnswerNextNodeId, isAfterHours, origin)
    );
  }

  // -------------------------------------------------------------------------
  // Staff-leg status callback: a leg ended without bridging. Drive the ring plan
  // forward (cascade to next number, or detect simultaneous exhaustion).
  // -------------------------------------------------------------------------
  private async handleAgentStatus(body: AgentStatusEvent): Promise<Response> {
    // Any terminal agent-leg status (including a normal post-bridge hangup, which the ring-plan
    // logic below deliberately ignores) may have left a lone participant behind.
    if (body.callStatus === "completed" || (body.callStatus && AGENT_FAILURE_STATUSES.has(body.callStatus))) {
      await cleanupLoneConference(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_AUTH_TOKEN, body.callSid);
      // Softphone outbound: if the agent's leg ended, cancel the dialed-out (target) leg so it
      // stops ringing the callee. No-op if that leg already answered/ended (cancel then errors,
      // which we swallow). Skip when it's the target's own status firing this callback.
      const outbound = await this.env.DB.prepare("SELECT outbound_target_sid FROM calls WHERE id = ?")
        .bind(body.callSid)
        .first<{ outbound_target_sid: string | null }>();
      const targetSid = outbound?.outbound_target_sid ?? null;
      if (targetSid && targetSid !== body.agentCallSid) {
        try {
          await this.cancelStaff(targetSid);
        } catch {
          /* target already connected or gone */
        }
      }
    }
    const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");
    if (
      !activeRing ||
      activeRing.ringPlanState.name !== "DIALING" ||
      !body.callStatus ||
      !AGENT_FAILURE_STATUSES.has(body.callStatus)
    ) {
      return new Response("ok", { status: 200 });
    }

    // Stale/duplicate delivery guard: Twilio can redeliver the same terminal (busy/no-answer/...)
    // status for a leg we've ALREADY processed and removed from attemptSids. Without this, a
    // redelivery would pass the DIALING guard mid-cascade and re-advance the plan (re-dialing or
    // double-advancing). If this sid is no longer tracked, no-op immediately. (Checked BEFORE the
    // filter below, which is what removes the sid on the first, legitimate delivery.)
    if (!activeRing.attemptSids.includes(body.agentCallSid)) {
      return new Response("ok", { status: 200 });
    }

    const origin = new URL(body.webhookUrl).origin;
    await this.advanceRingPlanOnFailedAttempt(activeRing, body.agentCallSid, body.callSid, origin);
    return new Response("ok", { status: 200 });
  }

  // -------------------------------------------------------------------------
  // Shared failed-attempt bookkeeping: removes `agentCallSid` from the active ring plan and
  // advances it exactly like a busy/no-answer/failed/canceled agent-status would -- cascade to the
  // next number, or detect simultaneous exhaustion. Used by BOTH:
  //  - handleAgentStatus, for real Twilio terminal failure statuses, and
  //  - the machine-answer branch of handleAgentAnswer, for a leg we deliberately hang up ourselves
  //    (whose own later Twilio status callback will report "completed", not a failure status, so
  //    it can't rely on handleAgentStatus to do this bookkeeping -- see the comment there).
  // Caller is responsible for checking `activeRing.ringPlanState.name === "DIALING"` and
  // `activeRing.attemptSids.includes(agentCallSid)` (duplicate-delivery guard) before calling.
  // -------------------------------------------------------------------------
  private async advanceRingPlanOnFailedAttempt(
    activeRing: ActiveRing,
    agentCallSid: string,
    callSid: string,
    origin: string
  ): Promise<void> {
    // Callers already verify this before invoking, but TS can't carry that narrowing across the
    // function boundary -- re-check here so `.strategy` below type-checks.
    if (activeRing.ringPlanState.name !== "DIALING") return;

    activeRing.attemptSids = activeRing.attemptSids.filter((sid) => sid !== agentCallSid);

    if (activeRing.ringPlanState.strategy === "cascade") {
      const { state, commands } = reduceRingPlan(activeRing.ringPlanState, { type: "ATTEMPT_FAILED" });
      const dialNext = commands.find((c) => c.type === "DIAL_NEXT");
      if (dialNext && dialNext.type === "DIAL_NEXT") {
        // Dial the next cascade number BEFORE committing the advanced state. If create-call
        // throws, do NOT persist the advanced DIALING state (which would expect a leg we never
        // created and could be re-processed on a redelivered status callback). Instead treat the
        // plan as exhausted → DONE{no_answer}; the caller then falls through to voicemail via the
        // existing queue_left/no-answer rail (renderNoAnswerFallthrough). Persist only after the
        // new dial genuinely succeeds.
        let nextSid: string;
        try {
          nextSid = await this.dialStaff(dialNext.number, callSid, origin, activeRing.ringConfig.timeoutSeconds);
        } catch {
          activeRing.ringPlanState = { name: "DONE", outcome: "no_answer" };
          await this.ctx.storage.put("activeRing", activeRing);
          return;
        }
        activeRing.ringPlanState = state;
        activeRing.attemptSids.push(nextSid);
      } else {
        // No DIAL_NEXT command → cascade exhausted; state is already DONE{no_answer}.
        activeRing.ringPlanState = state;
      }
    } else {
      // Simultaneous: a single failed leg is a no-op in the plan. Once every leg has
      // failed, fire ALL_ATTEMPTS_EXHAUSTED to transition to DONE{no_answer}.
      reduceRingPlan(activeRing.ringPlanState, { type: "ATTEMPT_FAILED" });
      if (activeRing.attemptSids.length === 0) {
        const { state } = reduceRingPlan(activeRing.ringPlanState, { type: "ALL_ATTEMPTS_EXHAUSTED" });
        activeRing.ringPlanState = state;
      }
    }

    await this.ctx.storage.put("activeRing", activeRing);
  }

  // ---- small helpers -----------------------------------------------------

  private renderHoldFor(activeRing: ActiveRing, origin: string): string {
    return renderHold({
      play: activeRing.play,
      baseUrl: origin,
      gatherAction: appendWebhookSecret(`${origin}/webhooks/twilio/hold-digit`, this.env.TWILIO_WEBHOOK_SECRET),
      // A wait node's own content is finite and self-terminating, so it only needs a comfortable
      // gap before repeating. The default ringback is a looping tone whose document length IS the
      // poll interval, so it gets the short tail instead.
      timeoutSeconds: activeRing.play ? HOLD_CONTENT_TIMEOUT_SECONDS : HOLD_RINGBACK_TIMEOUT_SECONDS,
    });
  }

  private async playFromConfig(config: Record<string, any>): Promise<FlowCommand | null> {
    const audioAssetId = config.audioAssetId ?? null;
    const ttsText = config.ttsText ?? null;
    if (audioAssetId === null && ttsText === null) return null;
    const resolved = await this.resolveAudioCommands([{ type: "PLAY", audioAssetId, ttsText }]);
    return resolved[0];
  }

  // Resolves every PLAY command's `audioAssetId` (an `ivr_audio_assets.id` primary key) to the
  // asset's real R2 key before the command reaches a TwiML renderer. The renderers
  // (renderFlowTwiml/renderFlowCommandsFragment/renderHold) build the media URL directly from
  // `audioAssetId`, so feeding them the bare id (rather than the R2 key the file is actually
  // stored under) would silently 404 when Twilio fetches it.
  private async resolveAudioCommands(commands: FlowCommand[]): Promise<FlowCommand[]> {
    const resolved: FlowCommand[] = [];
    for (const command of commands) {
      if (command.type === "PLAY" && command.audioAssetId !== null) {
        const asset = await getAudioAsset(this.env.DB, command.audioAssetId);
        if (!asset) {
          throw new Error(`IVR flow references unknown audio asset id "${command.audioAssetId}"`);
        }
        resolved.push({ ...command, audioAssetId: asset.r2Key });
      } else {
        resolved.push(command);
      }
    }
    return resolved;
  }

  private async dialStaff(number: string, callSid: string, origin: string, timeoutSeconds?: number): Promise<string> {
    // A ring target is either a softphone identity ("client:{email}") or a personal mobile
    // ("pstn:{email}|{e164}", see resolveRingTargets). For a softphone we pass the real caller's
    // number as a custom Client param (CallerNumber); for a PSTN mobile we dial the number directly
    // (custom params don't reach the PSTN, and the mobile just shows our business From).
    let to: string;
    let ownerEmail: string;
    // ASYNCHRONOUS AMD: only for the pstn mobile leg. A staff member's personal carrier voicemail
    // must never hijack a business call, so a machine answer there gets torn down (handleAmdStatus).
    // It must be async: Twilio's default synchronous AMD BLOCKS the call until the classifier
    // decides, so the staff member is connected but the caller keeps hearing ringback for another
    // 2-4s -- reported as "I answered on my mobile but the caller kept ringing". Async bridges
    // immediately and delivers the verdict later to asyncAmdStatusCallback.
    // Client (softphone) legs get no AMD -- undefined here means "no MachineDetection param sent".
    let machineDetection: "Enable" | undefined;
    let asyncAmdStatusCallback: string | undefined;
    if (number.startsWith("pstn:")) {
      const rest = number.slice("pstn:".length);
      const sep = rest.indexOf("|");
      ownerEmail = rest.slice(0, sep);
      to = rest.slice(sep + 1);
      machineDetection = "Enable";
      asyncAmdStatusCallback = appendWebhookSecret(
        `${origin}/webhooks/twilio/amd-status?callSid=${callSid}`,
        this.env.TWILIO_WEBHOOK_SECRET
      );
    } else {
      // The staff leg's `From` stays our own owned business number -- Twilio's Caller-ID-ownership
      // rules for the `From` field are murky for calls terminating at a `client:` identity (vs a real
      // PSTN destination), so we don't gamble on passing the raw external caller's number there. Instead
      // the real caller's number rides along as a custom Client parameter (Twilio's own documented
      // mechanism for this: "Sending Custom Parameters to Clients"), which the softphone reads via
      // call.customParameters.get('CallerNumber') to show the actual caller instead of our own number.
      ownerEmail = number.startsWith("client:") ? number.slice("client:".length) : number;
      const callerRow = await this.env.DB.prepare("SELECT caller_number FROM calls WHERE id = ?")
        .bind(callSid)
        .first<{ caller_number: string }>();
      // Bare digits (no leading "+"): whether Twilio decodes this client-URI query value zero or one
      // times before we read it back client-side is unverified, and a "+" is ambiguous either way (it
      // can decode to a literal space). Digits-only survives both interpretations identically, and the
      // client-side normalizer/formatter both already handle a bare-digits "61..." number correctly.
      to = callerRow?.caller_number
        ? `${number}?CallerNumber=${encodeURIComponent(callerRow.caller_number.replace(/^\+/, ""))}`
        : number;
    }
    const { sid } = await createOutboundCall(
      this.env.TWILIO_ACCOUNT_SID,
      this.env.TWILIO_API_KEY_SID,
      this.env.TWILIO_API_KEY_SECRET,
      {
        to,
        from: this.env.TWILIO_FROM_NUMBER,
        url: appendWebhookSecret(`${origin}/webhooks/twilio/agent-answer?callSid=${callSid}`, this.env.TWILIO_WEBHOOK_SECRET),
        statusCallback: appendWebhookSecret(`${origin}/webhooks/twilio/agent-status?callSid=${callSid}`, this.env.TWILIO_WEBHOOK_SECRET),
        statusCallbackEvent: ["completed"],
        // Ring for the node's configured timeout (fall back to 20s) before Twilio declares the leg
        // unanswered, so cascade/no-answer fall-through happens promptly.
        timeoutSeconds: typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds : 20,
        machineDetection,
        asyncAmd: machineDetection ? true : undefined,
        asyncAmdStatusCallback,
      }
    );
    // Record this leg's ownership so handlePostHold/handlePostTransfer/handlePostCompleteTransfer
    // can later verify a client-submitted CallSid actually belongs to the AUTHENTICATED staff
    // member, not just that it's someone's leg in the conference. `callSid` here is the caller's
    // own CallSid, which is also the queue/conference name (see startRing's renderEnqueue call).
    await recordCallLeg(this.env.DB, sid, ownerEmail, callSid);
    return sid;
  }

  private async cancelStaff(sid: string): Promise<void> {
    await cancelCall(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_API_KEY_SID, this.env.TWILIO_API_KEY_SECRET, sid);
  }

  // Best-effort append to the per-call event timeline. Never let a logging failure break the
  // actual call handling -- swallow and log any error.
  private async logEvent(callId: string, eventType: string, detail?: Record<string, unknown> | null): Promise<void> {
    try {
      await appendCallEvent(this.env.DB, callId, eventType, detail);
    } catch (err) {
      console.log("CALL_EVENT_LOG_FAILED", JSON.stringify({ callId, eventType, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  private async loadNodeConfig(nodeId: string): Promise<Record<string, any>> {
    const row = await this.env.DB.prepare("SELECT config FROM ivr_nodes WHERE id = ?")
      .bind(nodeId)
      .first<{ config: string }>();
    if (!row) {
      throw new Error(`CallSession: no ivr_nodes row found with id "${nodeId}"`);
    }
    return JSON.parse(row.config) as Record<string, any>;
  }

  private xml(body: string): Response {
    return new Response(body, { headers: { "Content-Type": "text/xml" } });
  }
}

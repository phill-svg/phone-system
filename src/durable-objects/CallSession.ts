import { DurableObject } from "cloudflare:workers";
import { advanceFlow, walkFromNode, type FlowCommand } from "../ivr/flowEngine";
import { renderFlowTwiml, renderFlowCommandsFragment, wrapResponse } from "../twilio/flowTwiml";
import {
  renderEnqueue,
  renderHold,
  renderLeave,
  renderCallbackAck,
} from "../twilio/queueTwiml";
import { resolveRingTargets, type RingNodeTarget } from "../dial/ringQueue";
import {
  reduceRingPlan,
  type RingPlanState,
  type RingStrategy,
} from "../dial/ringPlan";
import { createOutboundCall, cancelCall, redirectCall } from "../twilio/restClient";
import { renderDialAgentIntoConference } from "../twilio/conferenceTwiml";
import { getBusinessHours } from "../db/settings";
import { createCallbackRequest } from "../db/callbackRequests";
import { getAudioAsset } from "../db/audioAssets";
import { recordCallLeg } from "../db/callLegs";
import { isWithinBusinessHours } from "../ivr/businessHours";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
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
};

type IvrPosition = { nodeId: string; attempt: number };

type WalkResult = { nextNodeId: string; attempt: number; commands: FlowCommand[] };

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
type AgentAnswerEvent = { kind: "agent_answer"; callSid: string; agentCallSid: string; webhookUrl: string };
type AgentStatusEvent = {
  kind: "agent_status";
  callSid: string;
  agentCallSid: string;
  callStatus: string | null;
  webhookUrl: string;
};

type AnyEvent =
  | MainWebhookEvent
  | HoldPollEvent
  | HoldDigitEvent
  | QueueLeftEvent
  | AgentAnswerEvent
  | AgentStatusEvent;

const HOLD_TIMEOUT_SECONDS = 20;
const AGENT_FAILURE_STATUSES = new Set(["busy", "no-answer", "failed", "canceled"]);

export class CallSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as AnyEvent;
    if (body.kind === "hold_poll") return this.handleHoldPoll(body);
    if (body.kind === "hold_digit") return this.handleHoldDigit(body);
    if (body.kind === "queue_left") return this.handleQueueLeft(body);
    if (body.kind === "agent_answer") return this.handleAgentAnswer(body);
    if (body.kind === "agent_status") return this.handleAgentStatus(body);
    return this.handleMainWebhook(body);
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
        "UPDATE calls SET status = 'completed', ended_at = ?, recording_url = ?, recording_sid = ?, mailbox_label = ? WHERE id = ?"
      )
        .bind(Date.now(), body.recordingUrl, body.recordingSid, mailboxLabel, callSid)
        .run();
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

      const result = await advanceFlow(this.env.DB, "main", null, { type: "ENTER" }, isAfterHours, 0);
      return this.xml(await this.applyWalkResult(callSid, result, isAfterHours, origin));
    }

    // (c) Continuing from a gather node (digit or timeout/invalid).
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
      const record = `<Record action="${origin}/webhooks/twilio" method="POST" maxLength="120" timeout="5" playBeep="true"/>`;
      return wrapResponse(fragment + record);
    }

    // Ordinary gather turn (or terminal hangup): patch the GATHER action to the
    // main webhook so the caller's next digit comes back to this DO.
    await this.ctx.storage.put("ivrPosition", {
      nodeId: walkResult.nextNodeId,
      attempt: walkResult.attempt,
    });
    const mainWebhookUrl = `${origin}/webhooks/twilio`;
    const patched = walkResult.commands.map((c) =>
      c.type === "GATHER" ? { ...c, action: mainWebhookUrl } : c
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
    const numbers = await resolveRingTargets(this.env.DB, ringConfig.target, new Date());

    // Zero on-call numbers: skip the whole ring/enqueue dance and continue the flow from the
    // ring node's noAnswerNextNodeId (e.g. an emergency ring with nobody on call → voicemail).
    if (numbers.length === 0) {
      return this.renderNoAnswerFallthrough(callSid, ringConfig.noAnswerNextNodeId, isAfterHours, origin);
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

    // Dial each leg in its own try/catch. If any create-call throws part-way through a
    // multi-number simultaneous batch, the earlier legs are REAL ringing Twilio calls — cancel
    // every leg we did manage to create, then fall through to the no-answer path so the caller
    // still gets valid TwiML (voicemail/etc.) instead of an opaque 500. Only build + persist
    // `activeRing` once the WHOLE batch has succeeded, so a later agent_answer never reads a
    // half-populated (or missing) activeRing.
    const attemptSids: string[] = [];
    let dialFailed = false;
    for (const number of numbersToDial) {
      try {
        attemptSids.push(await this.dialStaff(number, callSid, origin));
      } catch {
        dialFailed = true;
        break;
      }
    }

    if (dialFailed) {
      for (const sid of attemptSids) {
        // Best-effort cleanup: a cancel failure must not itself abort the fallthrough TwiML.
        try {
          await this.cancelStaff(sid);
        } catch {
          /* leg may already be torn down; ignore */
        }
      }
      return this.renderNoAnswerFallthrough(callSid, ringConfig.noAnswerNextNodeId, isAfterHours, origin);
    }

    const activeRing: ActiveRing = {
      ringNodeId,
      play,
      allowCallbackStar,
      ringConfig,
      ringPlanState,
      attemptSids,
    };
    await this.ctx.storage.put("activeRing", activeRing);

    return renderEnqueue({
      queueName: callSid,
      waitUrl: `${origin}/webhooks/twilio/hold`,
      actionUrl: `${origin}/webhooks/twilio/queue-left`,
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
    if (activeRing && activeRing.ringPlanState.name === "DIALING") {
      return this.xml(this.renderHoldFor(activeRing, origin));
    }
    return this.xml(renderLeave());
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
      await this.env.DB.prepare(
        "UPDATE calls SET status = 'completed', ended_at = ?, ivr_path = ? WHERE id = ?"
      )
        .bind(Date.now(), activeRing.ringNodeId, body.callSid)
        .run();
      await this.ctx.storage.delete("activeRing");
      return this.xml(wrapResponse("<Hangup/>"));
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
      await this.ctx.storage.delete("activeRing");
      return this.xml(renderCallbackAck("Thanks, we'll call you back soon."));
    }

    // no_answer (or, defensively, an unexpected non-DONE state): continue the flow
    // from the ring node's noAnswerNextNodeId.
    //
    // KNOWN DEFERRED LIMITATION: if the caller hangs up mid-ring, this fires while the plan is
    // still DIALING and the outstanding staff `attemptSids` are NOT cancelled here, so those
    // outbound legs keep ringing into a now-dead queue. Cancelling them requires routing
    // /webhooks/twilio/status through the DO, which it deliberately does not do today — left for
    // a later real-call hardening pass.
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

    await redirectCall(
      this.env.TWILIO_ACCOUNT_SID,
      this.env.TWILIO_AUTH_TOKEN,
      body.callSid,
      `${origin}/webhooks/twilio/join-conference?conf=${body.callSid}`
    );

    return this.xml(
      renderDialAgentIntoConference({
        conferenceName: body.callSid,
        actionUrl: `${origin}/webhooks/twilio/agent-status?callSid=${body.callSid}`,
        recordingStatusCallbackUrl: `${origin}/webhooks/twilio/recording-status?callSid=${body.callSid}`,
      })
    );
  }

  // -------------------------------------------------------------------------
  // Staff-leg status callback: a leg ended without bridging. Drive the ring plan
  // forward (cascade to next number, or detect simultaneous exhaustion).
  // -------------------------------------------------------------------------
  private async handleAgentStatus(body: AgentStatusEvent): Promise<Response> {
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
    activeRing.attemptSids = activeRing.attemptSids.filter((sid) => sid !== body.agentCallSid);

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
          nextSid = await this.dialStaff(dialNext.number, body.callSid, origin);
        } catch {
          activeRing.ringPlanState = { name: "DONE", outcome: "no_answer" };
          await this.ctx.storage.put("activeRing", activeRing);
          return new Response("ok", { status: 200 });
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
    return new Response("ok", { status: 200 });
  }

  // ---- small helpers -----------------------------------------------------

  private renderHoldFor(activeRing: ActiveRing, origin: string): string {
    return renderHold({
      play: activeRing.play,
      baseUrl: origin,
      gatherAction: `${origin}/webhooks/twilio/hold-digit`,
      timeoutSeconds: HOLD_TIMEOUT_SECONDS,
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

  private async dialStaff(number: string, callSid: string, origin: string): Promise<string> {
    const { sid } = await createOutboundCall(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_AUTH_TOKEN, {
      to: number,
      from: this.env.TWILIO_FROM_NUMBER,
      url: `${origin}/webhooks/twilio/agent-answer?callSid=${callSid}`,
      statusCallback: `${origin}/webhooks/twilio/agent-status?callSid=${callSid}`,
      statusCallbackEvent: ["completed", "busy", "no-answer", "failed", "canceled"],
    });
    // `number` is always a `client:{email}` identity (see resolveRingTargets) -- record this leg's
    // ownership so handlePostHold/handlePostTransfer/handlePostCompleteTransfer can later verify a
    // client-submitted CallSid actually belongs to the AUTHENTICATED staff member, not just that
    // it's someone's leg in the conference. `callSid` here is the caller's own CallSid, which is
    // also the queue/conference name (see startRing's renderEnqueue call).
    const email = number.startsWith("client:") ? number.slice("client:".length) : number;
    await recordCallLeg(this.env.DB, sid, email, callSid);
    return sid;
  }

  private async cancelStaff(sid: string): Promise<void> {
    await cancelCall(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_AUTH_TOKEN, sid);
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

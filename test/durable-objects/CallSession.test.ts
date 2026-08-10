import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBusinessHours, setStaffRingList, type StaffRingEntry } from "../../src/db/settings";
import { createAudioAsset } from "../../src/db/audioAssets";
import type { CallSession } from "../../src/durable-objects/CallSession";

const ORIGIN = "https://tcb-voip.example.workers.dev";
const NOW = Date.now();

// --- node seeding (D1 is NOT reset between tests in this pool; beforeEach clears ivr_nodes) ---
async function seedNode(node: {
  id: string;
  flow?: string;
  isEntry?: boolean;
  type: string;
  config: unknown;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(node.id, node.flow ?? "main", node.isEntry ? 1 : 0, node.type, JSON.stringify(node.config), NOW, NOW)
    .run();
}

// The DO always drives flow="main". These are the building blocks each scenario assembles.
async function seedEntryGather(opts: {
  option1?: string; // nextNodeId for digit "1"
  defaultNextNodeId: string;
  retryLimit?: number;
}): Promise<void> {
  await seedNode({
    id: "main_entry_gather",
    isEntry: true,
    type: "gather",
    config: {
      audioAssetId: null,
      ttsText: "Press 1 to connect, or hold.",
      options: opts.option1 ? [{ digit: "1", nextNodeId: opts.option1 }] : [],
      defaultNextNodeId: opts.defaultNextNodeId,
      retryLimit: opts.retryLimit ?? 0,
    },
  });
}

async function seedRing(id: string, opts: {
  target?: "all" | "on_call_only";
  strategy?: "cascade" | "simultaneous";
  noAnswerNextNodeId: string;
}): Promise<void> {
  await seedNode({
    id,
    type: "ring",
    config: {
      target: opts.target ?? "all",
      strategy: opts.strategy ?? "cascade",
      timeoutSeconds: 20,
      noAnswerNextNodeId: opts.noAnswerNextNodeId,
    },
  });
}

async function seedVoicemail(id: string, mailboxLabel: string): Promise<void> {
  await seedNode({
    id,
    type: "voicemail",
    config: { audioAssetId: null, ttsText: "Please leave a message after the tone.", mailboxLabel },
  });
}

async function seedWait(id: string, opts: { nextNodeId: string; allowCallbackStar: boolean }): Promise<void> {
  await seedNode({
    id,
    type: "wait",
    config: {
      audioAssetId: null,
      ttsText: "Please hold, connecting you now.",
      allowCallbackStar: opts.allowCallbackStar,
      nextNodeId: opts.nextNodeId,
    },
  });
}

// --- event body builders (mirror the JSON worker.ts forwards) ---
function mainEvent(callSid: string, o: Partial<{ from: string; to: string; digits: string | null }> = {}) {
  return {
    callSid,
    from: o.from ?? "+61400000000",
    to: o.to ?? "+61200000000",
    digits: o.digits ?? null,
    recordingUrl: null,
    recordingSid: null,
    recordingDuration: null,
    webhookUrl: `${ORIGIN}/webhooks/twilio`,
  };
}

function recordingEvent(callSid: string, recordingUrl: string, recordingSid: string) {
  return {
    callSid,
    from: "+61400000000",
    to: "+61200000000",
    digits: null,
    recordingUrl,
    recordingSid,
    recordingDuration: "12",
    webhookUrl: `${ORIGIN}/webhooks/twilio`,
  };
}

const holdDigit = (callSid: string, digits: string | null) => ({
  kind: "hold_digit",
  callSid,
  digits,
  webhookUrl: `${ORIGIN}/webhooks/twilio/hold-digit`,
});
const queueLeft = (callSid: string, queueResult: string | null = "bridged") => ({
  kind: "queue_left",
  callSid,
  queueResult,
  webhookUrl: `${ORIGIN}/webhooks/twilio/queue-left`,
});
const agentAnswer = (callSid: string, agentCallSid: string) => ({
  kind: "agent_answer",
  callSid,
  agentCallSid,
  webhookUrl: `${ORIGIN}/webhooks/twilio/agent-answer?callSid=${callSid}`,
});
const agentStatus = (callSid: string, agentCallSid: string, callStatus: string) => ({
  kind: "agent_status",
  callSid,
  agentCallSid,
  callStatus,
  webhookUrl: `${ORIGIN}/webhooks/twilio/agent-status?callSid=${callSid}`,
});

function stubFor(callSid: string) {
  const id = env.CALL_SESSION.idFromName(callSid);
  return env.CALL_SESSION.get(id);
}

// Invoke the DO and drain the body immediately (Windows EBUSY teardown note, see task-8-report.md).
async function send(stub: DurableObjectStub, body: unknown): Promise<{ status: number; xml: string }> {
  const res = await runInDurableObject(stub, (instance) =>
    (instance as unknown as CallSession).fetch(
      new Request("https://internal/events", { method: "POST", body: JSON.stringify(body) })
    )
  );
  const xml = await res.text();
  return { status: res.status, xml };
}

// Count Twilio outbound-call REST hits, and list the "To" numbers dialed.
function outboundDials(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/Calls.json"))
    .map((c) => new URLSearchParams((c[1] as RequestInit).body as string).get("To") as string);
}
function cancelHits(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => /\/Calls\/[^/]+\.json$/.test(u));
}

describe("CallSession", () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM callback_requests").run();
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
    await env.DB.prepare("DELETE FROM ivr_audio_assets").run();
    await setBusinessHours(env.DB, {
      mon: { open: "00:00", close: "23:59" },
      tue: { open: "00:00", close: "23:59" },
      wed: { open: "00:00", close: "23:59" },
      thu: { open: "00:00", close: "23:59" },
      fri: { open: "00:00", close: "23:59" },
      sat: { open: "00:00", close: "23:59" },
      sun: { open: "00:00", close: "23:59" },
    });

    fetchMock.mockReset();
    // Twilio create-call returns a sid derived from the dialed number (deterministic for assertions);
    // cancel-call (and anything else) returns 200. D1 uses bindings, not global fetch, so this is safe.
    fetchMock.mockImplementation(async (input: unknown, init: unknown) => {
      const u = String(input);
      if (u.includes("/Calls.json")) {
        const to = new URLSearchParams((init as RequestInit).body as string).get("To");
        return new Response(JSON.stringify({ sid: `sid-${to}` }), { status: 201 });
      }
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function setRingList(entries: StaffRingEntry[]) {
    await setStaffRingList(env.DB, entries);
  }

  it("first webhook answers with the entry gather prompt + <Gather> pointed at the main webhook", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-smoke");
    const { status, xml } = await send(stub, mainEvent("CA-smoke"));

    expect(status).toBe(200);
    expect(xml).toContain("Press 1 to connect");
    expect(xml).toContain("<Gather");
    expect(xml).toContain(`action="${ORIGIN}/webhooks/twilio"`);

    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind("CA-smoke").first();
    expect(row).toMatchObject({
      id: "CA-smoke",
      caller_number: "+61400000000",
      called_number: "+61200000000",
      direction: "inbound",
    });
  });

  it("gather → cascade ring (no wait): digit 1 enqueues the caller and fires one outbound staff call", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-enq");
    await send(stub, mainEvent("CA-enq"));
    const { xml } = await send(stub, mainEvent("CA-enq", { digits: "1" }));

    expect(xml).toContain("<Enqueue");
    expect(xml).toContain("CA-enq"); // per-call queue name
    expect(outboundDials(fetchMock)).toEqual(["+61411111111"]);
  });

  it("full bridge: enqueue → agent_answer renders <Dial><Queue> → queue_left(bridged) completes the call", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-bridge");
    await send(stub, mainEvent("CA-bridge"));
    await send(stub, mainEvent("CA-bridge", { digits: "1" }));

    const answer = await send(stub, agentAnswer("CA-bridge", "sid-+61411111111"));
    expect(answer.xml).toContain("<Dial");
    expect(answer.xml).toContain("<Queue>CA-bridge</Queue>");

    const left = await send(stub, queueLeft("CA-bridge"));
    expect(left.xml).toContain("<Hangup/>");

    const row = await env.DB.prepare("SELECT status, ended_at, ivr_path FROM calls WHERE id = ?")
      .bind("CA-bridge")
      .first<{ status: string; ended_at: number; ivr_path: string }>();
    expect(row?.status).toBe("completed");
    expect(row?.ended_at).toBeGreaterThan(0);
    expect(row?.ivr_path).toBe("main_ring");
  });

  it("cascade ring-down: first staff leg fails via agent_status, the next number is dialed, then answers", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "cascade", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([
      { label: "Phill", number: "+61411111111" },
      { label: "Sam", number: "+61422222222" },
    ]);

    const stub = stubFor("CA-cascade");
    await send(stub, mainEvent("CA-cascade"));
    await send(stub, mainEvent("CA-cascade", { digits: "1" }));

    // Only the first number is dialed initially (cascade).
    expect(outboundDials(fetchMock)).toEqual(["+61411111111"]);

    // First leg fails → second number is now dialed.
    await send(stub, agentStatus("CA-cascade", "sid-+61411111111", "no-answer"));
    expect(outboundDials(fetchMock)).toEqual(["+61411111111", "+61422222222"]);

    // Second leg answers → bridges.
    const answer = await send(stub, agentAnswer("CA-cascade", "sid-+61422222222"));
    expect(answer.xml).toContain("<Dial");

    const left = await send(stub, queueLeft("CA-cascade"));
    expect(left.xml).toContain("<Hangup/>");
    const row = await env.DB.prepare("SELECT status FROM calls WHERE id = ?").bind("CA-cascade").first<{ status: string }>();
    expect(row?.status).toBe("completed");
  });

  it("simultaneous ring-all fires an outbound call to every number at once", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "simultaneous", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([
      { label: "Phill", number: "+61411111111" },
      { label: "Sam", number: "+61422222222" },
      { label: "Jo", number: "+61433333333" },
    ]);

    const stub = stubFor("CA-simul");
    await send(stub, mainEvent("CA-simul"));
    const { xml } = await send(stub, mainEvent("CA-simul", { digits: "1" }));

    expect(xml).toContain("<Enqueue");
    expect(outboundDials(fetchMock).sort()).toEqual(
      ["+61411111111", "+61422222222", "+61433333333"].sort()
    );

    // First leg answers → the other two are cancelled.
    const answer = await send(stub, agentAnswer("CA-simul", "sid-+61411111111"));
    expect(answer.xml).toContain("<Dial");
    expect(cancelHits(fetchMock).length).toBe(2);
  });

  it("emergency ring with nobody on call skips enqueue entirely and goes straight to voicemail", async () => {
    await seedEntryGather({ option1: "main_ring_emergency", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring_emergency", { target: "on_call_only", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    // Staff exist but none are on call.
    await setRingList([
      { label: "Phill", number: "+61411111111", isOnCall: false },
      { label: "Sam", number: "+61422222222", isOnCall: false },
    ]);

    const stub = stubFor("CA-emerg");
    await send(stub, mainEvent("CA-emerg"));
    const { xml } = await send(stub, mainEvent("CA-emerg", { digits: "1" }));

    expect(xml).not.toContain("<Enqueue");
    expect(xml).toContain("<Record");
    expect(outboundDials(fetchMock)).toEqual([]);
  });

  it("callback star-press while on hold creates a callback_requests row and acknowledges", async () => {
    await seedEntryGather({ option1: "main_wait", defaultNextNodeId: "main_vm" });
    await seedWait("main_wait", { nextNodeId: "main_ring", allowCallbackStar: true });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-cb");
    await send(stub, mainEvent("CA-cb"));
    const enq = await send(stub, mainEvent("CA-cb", { digits: "1" }));
    expect(enq.xml).toContain("<Enqueue");

    // Caller presses star on hold.
    const digit = await send(stub, holdDigit("CA-cb", "*"));
    expect(digit.xml).toContain("<Leave/>");
    expect(cancelHits(fetchMock).length).toBe(1); // the one outstanding staff leg is cancelled

    // Queue action fires after the caller leaves.
    const left = await send(stub, queueLeft("CA-cb", "leave"));
    expect(left.xml).toContain("call you back");

    const cb = await env.DB.prepare("SELECT call_id, caller_number, status FROM callback_requests WHERE call_id = ?")
      .bind("CA-cb")
      .first<{ call_id: string; caller_number: string; status: string }>();
    expect(cb).toMatchObject({ call_id: "CA-cb", caller_number: "+61400000000", status: "open" });

    const row = await env.DB.prepare("SELECT status FROM calls WHERE id = ?").bind("CA-cb").first<{ status: string }>();
    expect(row?.status).toBe("completed");
  });

  it("hold poll keeps the caller holding while dialing", async () => {
    await seedEntryGather({ option1: "main_wait", defaultNextNodeId: "main_vm" });
    await seedWait("main_wait", { nextNodeId: "main_ring", allowCallbackStar: true });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-hold");
    await send(stub, mainEvent("CA-hold"));
    await send(stub, mainEvent("CA-hold", { digits: "1" }));

    const poll = await send(stub, { kind: "hold_poll", callSid: "CA-hold", webhookUrl: `${ORIGIN}/webhooks/twilio/hold` });
    expect(poll.xml).toContain("<Gather");
    expect(poll.xml).toContain("Please hold"); // wait-node hold content
  });

  it("no-answer path: queue_left after cascade exhaustion continues the flow to voicemail", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "cascade", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-noans");
    await send(stub, mainEvent("CA-noans"));
    await send(stub, mainEvent("CA-noans", { digits: "1" }));

    // The only staff leg fails → cascade exhausts → DONE{no_answer}.
    await send(stub, agentStatus("CA-noans", "sid-+61411111111", "no-answer"));

    const left = await send(stub, queueLeft("CA-noans", "leave"));
    expect(left.xml).toContain("<Record"); // fell through to voicemail
  });

  it("simultaneous ring: both legs fail → ALL_ATTEMPTS_EXHAUSTED → queue_left falls through to voicemail", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "simultaneous", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([
      { label: "Phill", number: "+61411111111" },
      { label: "Sam", number: "+61422222222" },
    ]);

    const stub = stubFor("CA-simul-noans");
    await send(stub, mainEvent("CA-simul-noans"));
    await send(stub, mainEvent("CA-simul-noans", { digits: "1" }));
    expect(outboundDials(fetchMock).length).toBe(2);

    // Both legs fail individually; the second failure empties attemptSids → EXHAUSTED → DONE{no_answer}.
    await send(stub, agentStatus("CA-simul-noans", "sid-+61411111111", "no-answer"));
    await send(stub, agentStatus("CA-simul-noans", "sid-+61422222222", "busy"));

    // Hold poll now sees a non-DIALING plan and tells the caller to leave the queue.
    const poll = await send(stub, {
      kind: "hold_poll",
      callSid: "CA-simul-noans",
      webhookUrl: `${ORIGIN}/webhooks/twilio/hold`,
    });
    expect(poll.xml).toContain("<Leave/>");

    const left = await send(stub, queueLeft("CA-simul-noans", "leave"));
    expect(left.xml).toContain("<Record"); // fell through to voicemail
  });

  it("voicemail <Record> action callback stores recording + mailbox label and completes the call", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm", retryLimit: 0 });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "3 after-hours");
    await setRingList([{ label: "Phill", number: "+61411111111" }]);

    const stub = stubFor("CA-vm");
    await send(stub, mainEvent("CA-vm"));
    // An unmatched digit with retryLimit 0 falls through to the default voicemail.
    const vm = await send(stub, mainEvent("CA-vm", { digits: "9" }));
    expect(vm.xml).toContain("<Record");

    // Twilio posts the recording back to the same main webhook/CallSid.
    const rec = await send(stub, recordingEvent("CA-vm", "https://api.twilio.com/rec/RE123", "RE123"));
    expect(rec.xml).toContain("<Hangup/>");

    const row = await env.DB.prepare(
      "SELECT status, recording_url, recording_sid, mailbox_label, ivr_path FROM calls WHERE id = ?"
    )
      .bind("CA-vm")
      .first<{
        status: string;
        recording_url: string;
        recording_sid: string;
        mailbox_label: string;
        ivr_path: string;
      }>();
    expect(row?.status).toBe("completed");
    expect(row?.recording_url).toBe("https://api.twilio.com/rec/RE123");
    expect(row?.recording_sid).toBe("RE123");
    expect(row?.mailbox_label).toBe("3 after-hours");
    expect(row?.ivr_path).toBe("main_vm");
  });

  // --- uploaded audio playback (Task 2's audio assets + PLAY commands) ---

  it("PLAY command referencing an uploaded audio asset's id renders <Play> with the asset's REAL r2Key, not the bare id", async () => {
    // The asset's id ("asset-1") is deliberately different from its r2Key
    // ("ivr-audio/asset-1"), mirroring how POST /api/ivr/audio actually stores things:
    // R2 object key = `ivr-audio/${id}`, which is NOT the same string as the
    // ivr_audio_assets.id primary key that flow node configs reference.
    await createAudioAsset(env.DB, {
      id: "asset-1",
      label: "Welcome greeting",
      r2Key: "ivr-audio/asset-1",
      contentType: "audio/mpeg",
    });

    // The entry gather node's prompt references the asset by its bare id.
    await seedNode({
      id: "main_entry_gather",
      isEntry: true,
      type: "gather",
      config: {
        audioAssetId: "asset-1",
        ttsText: null,
        options: [],
        defaultNextNodeId: "main_vm",
        retryLimit: 0,
      },
    });
    await seedVoicemail("main_vm", "default");

    const stub = stubFor("CA-audio");
    const { status, xml } = await send(stub, mainEvent("CA-audio"));

    expect(status).toBe(200);
    // The real R2 key, resolved via getAudioAsset, must appear in the rendered <Play> URL.
    expect(xml).toContain(`<Play>${ORIGIN}/media/ivr-audio/asset-1</Play>`);
    // The bug's broken output (the bare asset id fed straight into the media URL) must NOT appear.
    expect(xml).not.toContain(`${ORIGIN}/media/asset-1<`);
  });

  it("PLAY command referencing an unknown audio asset id throws a clear error instead of producing a broken URL", async () => {
    await seedNode({
      id: "main_entry_gather",
      isEntry: true,
      type: "gather",
      config: {
        audioAssetId: "does-not-exist",
        ttsText: null,
        options: [],
        defaultNextNodeId: "main_vm",
        retryLimit: 0,
      },
    });
    await seedVoicemail("main_vm", "default");

    const stub = stubFor("CA-audio-missing");
    await expect(send(stub, mainEvent("CA-audio-missing"))).rejects.toThrow(
      /unknown audio asset id "does-not-exist"/i
    );
  });

  // --- error-handling robustness (dial failures + duplicate status callbacks) ---

  // Make the create-call for a specific "To" number fail with a 500 (createOutboundCall throws on
  // !res.ok); every other create-call and all cancel-calls behave normally.
  function failCreateFor(failNumber: string) {
    fetchMock.mockImplementation(async (input: unknown, init: unknown) => {
      const u = String(input);
      if (u.includes("/Calls.json")) {
        const to = new URLSearchParams((init as RequestInit).body as string).get("To");
        if (to === failNumber) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ sid: `sid-${to}` }), { status: 201 });
      }
      return new Response("", { status: 200 });
    });
  }

  it("startRing: mid-batch simultaneous dial failure cancels the created leg(s) and falls through to voicemail (no enqueue)", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "simultaneous", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([
      { label: "Phill", number: "+61411111111" },
      { label: "Sam", number: "+61422222222" },
    ]);
    // First number dials OK, second throws mid-batch.
    failCreateFor("+61422222222");

    const stub = stubFor("CA-dialfail");
    await send(stub, mainEvent("CA-dialfail"));
    const { status, xml } = await send(stub, mainEvent("CA-dialfail", { digits: "1" }));

    // Caller got the voicemail fallback, NOT an enqueue, and NOT a 500.
    expect(status).toBe(200);
    expect(xml).not.toContain("<Enqueue");
    expect(xml).toContain("<Record");

    // Exactly the one successfully-created leg was cancelled.
    const cancels = cancelHits(fetchMock);
    expect(cancels.length).toBe(1);
    expect(cancels[0]).toContain("sid-+61411111111");

    // No activeRing was persisted (the whole batch failed), so a later hold poll just leaves.
    const poll = await send(stub, {
      kind: "hold_poll",
      callSid: "CA-dialfail",
      webhookUrl: `${ORIGIN}/webhooks/twilio/hold`,
    });
    expect(poll.xml).toContain("<Leave/>");
  });

  it("cascade: dialing the NEXT number fails via agent_status → plan goes no_answer, caller falls through to voicemail (no dangling activeRing)", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "cascade", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([
      { label: "Phill", number: "+61411111111" },
      { label: "Sam", number: "+61422222222" },
    ]);
    // The first (cascade) number dials OK; the second (the cascade advance) throws.
    failCreateFor("+61422222222");

    const stub = stubFor("CA-cascade-dialfail");
    await send(stub, mainEvent("CA-cascade-dialfail"));
    const enq = await send(stub, mainEvent("CA-cascade-dialfail", { digits: "1" }));
    expect(enq.xml).toContain("<Enqueue"); // first leg dialed OK → caller enqueued
    expect(outboundDials(fetchMock)).toEqual(["+61411111111"]);

    // First leg fails → attempt to dial the second throws → plan should transition to no_answer.
    const s = await send(stub, agentStatus("CA-cascade-dialfail", "sid-+61411111111", "no-answer"));
    expect(s.status).toBe(200);

    // No stale DIALING state waiting on a phantom leg: hold poll now sees non-DIALING → <Leave/>.
    const poll = await send(stub, {
      kind: "hold_poll",
      callSid: "CA-cascade-dialfail",
      webhookUrl: `${ORIGIN}/webhooks/twilio/hold`,
    });
    expect(poll.xml).toContain("<Leave/>");

    // queue_left falls through to voicemail rather than being stuck in a broken intermediate state.
    const left = await send(stub, queueLeft("CA-cascade-dialfail", "leave"));
    expect(left.xml).toContain("<Record");
  });

  it("duplicate terminal agent_status for an already-processed leg is a no-op (no re-advance / re-dial, attemptSids unchanged)", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { strategy: "cascade", noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await setRingList([
      { label: "Phill", number: "+61411111111" },
      { label: "Sam", number: "+61422222222" },
    ]);

    const stub = stubFor("CA-dup");
    await send(stub, mainEvent("CA-dup"));
    await send(stub, mainEvent("CA-dup", { digits: "1" }));
    expect(outboundDials(fetchMock)).toEqual(["+61411111111"]);

    // First delivery: first leg fails → second number dialed.
    await send(stub, agentStatus("CA-dup", "sid-+61411111111", "no-answer"));
    expect(outboundDials(fetchMock)).toEqual(["+61411111111", "+61422222222"]);

    // Snapshot state directly from DO storage after the first (legitimate) delivery.
    const before = await runInDurableObject(stub, async (instance) =>
      (instance as unknown as CallSession & { ctx: DurableObjectState }).ctx.storage.get("activeRing")
    );
    const dialsAfterFirst = outboundDials(fetchMock).length;
    const cancelsAfterFirst = cancelHits(fetchMock).length;

    // Duplicate delivery of the SAME terminal event for sid-+61411111111 (already removed).
    const dup = await send(stub, agentStatus("CA-dup", "sid-+61411111111", "no-answer"));
    expect(dup.status).toBe(200);

    // No extra dial or cancel triggered by the duplicate, and stored state is byte-identical.
    expect(outboundDials(fetchMock).length).toBe(dialsAfterFirst);
    expect(cancelHits(fetchMock).length).toBe(cancelsAfterFirst);
    const after = await runInDurableObject(stub, async (instance) =>
      (instance as unknown as CallSession & { ctx: DurableObjectState }).ctx.storage.get("activeRing")
    );
    expect(after).toEqual(before);

    // The second leg can still answer normally → bridge.
    const answer = await send(stub, agentAnswer("CA-dup", "sid-+61422222222"));
    expect(answer.xml).toContain("<Dial");
  });
});

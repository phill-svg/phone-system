import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { advanceFlow, walkFromNode } from "../../src/ivr/flowEngine";

const NOW = Date.now();

async function insertNode(node: {
  id: string;
  flow: string;
  isEntry?: boolean;
  type: string;
  config: unknown;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(node.id, node.flow, node.isEntry ? 1 : 0, node.type, JSON.stringify(node.config), NOW, NOW)
    .run();
}

describe("advanceFlow — seeded main flow (byte-for-byte parity with the old hardcoded menu)", () => {
  it("ENTER walks straight to the entry gather and renders its prompt + gather", async () => {
    const result = await advanceFlow(env.DB, "main", null, { type: "ENTER" }, false, 0);
    expect(result.nextNodeId).toBe("main_entry_gather");
    expect(result.attempt).toBe(0);
    expect(result.commands).toEqual([
      {
        type: "PLAY",
        audioAssetId: null,
        ttsText:
          "Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone.",
      },
      { type: "GATHER", numDigits: 1, timeoutSeconds: 8, validDigits: "1230", action: "PLACEHOLDER" },
    ]);
  });

  it.each([
    ["1", "main_ring_new_booking"],
    ["2", "main_ring_existing_job"],
    ["3", "main_ring_emergency"],
    ["0", "main_ring_operator"],
  ] as const)("digit %s from the entry gather hands off to ring node %s", async (digit, ringNodeId) => {
    const result = await advanceFlow(env.DB, "main", "main_entry_gather", { type: "DIGIT", digit }, false, 0);
    expect(result.nextNodeId).toBe(ringNodeId);
    expect(result.attempt).toBe(0);
    expect(result.commands).toEqual([{ type: "DIAL_HANDOFF" }]);
  });

  it("an invalid digit re-prompts the same gather and increments the attempt", async () => {
    const result = await advanceFlow(env.DB, "main", "main_entry_gather", { type: "DIGIT", digit: "9" }, false, 0);
    expect(result.nextNodeId).toBe("main_entry_gather");
    expect(result.attempt).toBe(1);
    expect(result.commands[0]).toMatchObject({ type: "PLAY" });
    expect(result.commands[1]).toMatchObject({ type: "GATHER" });
  });
});

describe("advanceFlow — new node types (date_rule / input / redirect)", () => {
  it("date_rule takes the closed branch on a listed closed date and the open branch otherwise", async () => {
    await insertNode({ id: "dr_entry", flow: "dr", isEntry: true, type: "date_rule", config: { closedDates: ["12-25", "2026-08-14"], openNextNodeId: "dr_open", closedNextNodeId: "dr_closed" } });
    await insertNode({ id: "dr_open", flow: "dr", type: "voicemail", config: { audioAssetId: null, ttsText: "Open VM", mailboxLabel: "open" } });
    await insertNode({ id: "dr_closed", flow: "dr", type: "voicemail", config: { audioAssetId: null, ttsText: "Closed VM", mailboxLabel: "closed" } });

    const closed = await advanceFlow(env.DB, "dr", null, { type: "ENTER" }, false, 0, new Date("2026-12-25T02:00:00Z"));
    expect(closed.nextNodeId).toBe("dr_closed");

    const open = await advanceFlow(env.DB, "dr", null, { type: "ENTER" }, false, 0, new Date("2026-07-01T02:00:00Z"));
    expect(open.nextNodeId).toBe("dr_open");
  });

  it("input node stops to collect digits, then captures the value and continues to nextNodeId", async () => {
    await insertNode({ id: "in_entry", flow: "inf", isEntry: true, type: "input", config: { audioAssetId: null, ttsText: "Enter your booking number", numDigits: 5, nextNodeId: "in_after" } });
    await insertNode({ id: "in_after", flow: "inf", type: "voicemail", config: { audioAssetId: null, ttsText: "Thanks", mailboxLabel: "after-input" } });

    const enter = await advanceFlow(env.DB, "inf", null, { type: "ENTER" }, false, 0);
    expect(enter.nextNodeId).toBe("in_entry");
    expect(enter.commands.some((c) => c.type === "INPUT")).toBe(true);

    const resumed = await advanceFlow(env.DB, "inf", "in_entry", { type: "DIGIT", digit: "12345" }, false, 0);
    expect(resumed.capturedInput).toEqual({ nodeId: "in_entry", value: "12345" });
    expect(resumed.nextNodeId).toBe("in_after");
    expect(resumed.commands.some((c) => c.type === "VOICEMAIL_HANDOFF")).toBe(true);
  });

  it("redirect node emits a REDIRECT command with the configured number", async () => {
    await insertNode({ id: "rd_entry", flow: "rdf", isEntry: true, type: "redirect", config: { number: "+61212345678" } });
    const result = await advanceFlow(env.DB, "rdf", null, { type: "ENTER" }, false, 0);
    expect(result.nextNodeId).toBe("rd_entry");
    expect(result.commands).toEqual([{ type: "REDIRECT", number: "+61212345678" }]);
  });

  it("a timeout re-prompts the same gather and increments the attempt", async () => {
    const result = await advanceFlow(env.DB, "main", "main_entry_gather", { type: "TIMEOUT_OR_INVALID" }, false, 1);
    expect(result.nextNodeId).toBe("main_entry_gather");
    expect(result.attempt).toBe(2);
  });

  it("exhausting retryLimit (3) falls back to the shared voicemail default", async () => {
    const result = await advanceFlow(env.DB, "main", "main_entry_gather", { type: "TIMEOUT_OR_INVALID" }, false, 3);
    expect(result.nextNodeId).toBe("shared_voicemail");
    expect(result.attempt).toBe(0);
    expect(result.commands).toEqual([
      {
        type: "PLAY",
        audioAssetId: null,
        ttsText:
          "Sorry we're unable to take your call right now. Please leave a message after the tone, including your name and number.",
      },
      { type: "VOICEMAIL_HANDOFF" },
    ]);
  });
});

describe("advanceFlow — seeded after_hours flow", () => {
  it("ENTER walks to the after-hours entry gather", async () => {
    const result = await advanceFlow(env.DB, "after_hours", null, { type: "ENTER" }, true, 0);
    expect(result.nextNodeId).toBe("after_hours_entry_gather");
    expect(result.commands).toEqual([
      {
        type: "PLAY",
        audioAssetId: null,
        ttsText: "For a pest emergency, press 1. Otherwise, please leave a message after the tone.",
      },
      { type: "GATHER", numDigits: 1, timeoutSeconds: 8, validDigits: "1", action: "PLACEHOLDER" },
    ]);
  });

  it("digit 1 hands off to the on-call-only emergency ring node", async () => {
    const result = await advanceFlow(
      env.DB,
      "after_hours",
      "after_hours_entry_gather",
      { type: "DIGIT", digit: "1" },
      true,
      0
    );
    expect(result.nextNodeId).toBe("after_hours_ring_emergency");
    expect(result.commands).toEqual([{ type: "DIAL_HANDOFF" }]);
  });

  it("retryLimit of 1: first invalid digit retries once", async () => {
    const result = await advanceFlow(
      env.DB,
      "after_hours",
      "after_hours_entry_gather",
      { type: "DIGIT", digit: "9" },
      true,
      0
    );
    expect(result.nextNodeId).toBe("after_hours_entry_gather");
    expect(result.attempt).toBe(1);
  });

  it("second invalid digit (attempt already at retryLimit) falls back to shared voicemail", async () => {
    const result = await advanceFlow(
      env.DB,
      "after_hours",
      "after_hours_entry_gather",
      { type: "DIGIT", digit: "9" },
      true,
      1
    );
    expect(result.nextNodeId).toBe("shared_voicemail");
    expect(result.commands.some((c) => c.type === "VOICEMAIL_HANDOFF")).toBe(true);
  });
});

describe("advanceFlow — reference-diagram node shapes (test-only nodes)", () => {
  it("business_hours (open) -> play -> ring stops at the ring node with a DIAL_HANDOFF", async () => {
    await insertNode({
      id: "diag_bh_ring",
      flow: "diagram_ring_test",
      isEntry: true,
      type: "business_hours",
      config: { openNextNodeId: "diag_play_welcome", closedNextNodeId: "diag_vm_afterhours" },
    });
    await insertNode({
      id: "diag_play_welcome",
      flow: "diagram_ring_test",
      type: "play",
      config: { audioAssetId: null, ttsText: "Welcome to TCB Pest Control", nextNodeId: "diag_ring_30s" },
    });
    await insertNode({
      id: "diag_ring_30s",
      flow: "diagram_ring_test",
      type: "ring",
      config: { target: "all", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "diag_vm_afterhours" },
    });
    await insertNode({
      id: "diag_vm_afterhours",
      flow: "diagram_ring_test",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "Leave a message", mailboxLabel: "4 after-hours" },
    });

    const result = await advanceFlow(env.DB, "diagram_ring_test", null, { type: "ENTER" }, false, 0);
    expect(result.nextNodeId).toBe("diag_ring_30s");
    expect(result.commands).toEqual([
      { type: "PLAY", audioAssetId: null, ttsText: "Welcome to TCB Pest Control" },
      { type: "DIAL_HANDOFF" },
    ]);
  });

  it("business_hours (closed) branches straight to the after-hours voicemail", async () => {
    // Reuses the nodes inserted by the previous test (same D1 instance is not reset between `it`s
    // within a file under vitest-pool-workers' isolated storage per test... so insert independently.)
    await insertNode({
      id: "diag2_bh",
      flow: "diagram_ring_test_2",
      isEntry: true,
      type: "business_hours",
      config: { openNextNodeId: "diag2_play_welcome", closedNextNodeId: "diag2_vm_afterhours" },
    });
    await insertNode({
      id: "diag2_play_welcome",
      flow: "diagram_ring_test_2",
      type: "play",
      config: { audioAssetId: null, ttsText: "Welcome", nextNodeId: "diag2_ring" },
    });
    await insertNode({
      id: "diag2_ring",
      flow: "diagram_ring_test_2",
      type: "ring",
      config: { target: "all", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "diag2_vm_afterhours" },
    });
    await insertNode({
      id: "diag2_vm_afterhours",
      flow: "diagram_ring_test_2",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "Leave a message, greeting 4", mailboxLabel: "4 after-hours" },
    });

    const result = await advanceFlow(env.DB, "diagram_ring_test_2", null, { type: "ENTER" }, true, 0);
    expect(result.nextNodeId).toBe("diag2_vm_afterhours");
    expect(result.commands).toEqual([
      { type: "PLAY", audioAssetId: null, ttsText: "Leave a message, greeting 4" },
      { type: "VOICEMAIL_HANDOFF" },
    ]);
  });

  it("menu gather branches to voicemail on digit 1, or to a wait (hold) node on anything else — no retries", async () => {
    await insertNode({
      id: "diag_menu",
      flow: "diagram_menu_test",
      isEntry: true,
      type: "gather",
      config: {
        audioAssetId: null,
        ttsText: "Press 1 to leave a message, or hold for the next available operator",
        options: [{ digit: "1", nextNodeId: "diag_vm3" }],
        defaultNextNodeId: "diag_wait",
        retryLimit: 0,
      },
    });
    await insertNode({
      id: "diag_vm3",
      flow: "diagram_menu_test",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "Leave a message, greeting 3", mailboxLabel: "3" },
    });
    await insertNode({
      id: "diag_wait",
      flow: "diagram_menu_test",
      type: "wait",
      config: { audioAssetId: null, ttsText: "Please hold, you're in the queue", allowCallbackStar: false, nextNodeId: "diag_ring_500s" },
    });
    await insertNode({
      id: "diag_ring_500s",
      flow: "diagram_menu_test",
      type: "ring",
      config: { target: "all", strategy: "cascade", timeoutSeconds: 500, noAnswerNextNodeId: "diag_vm3a" },
    });
    await insertNode({
      id: "diag_vm3a",
      flow: "diagram_menu_test",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "Leave a message, greeting 3a", mailboxLabel: "3a" },
    });

    const digitOne = await advanceFlow(env.DB, "diagram_menu_test", "diag_menu", { type: "DIGIT", digit: "1" }, false, 0);
    expect(digitOne.nextNodeId).toBe("diag_vm3");
    expect(digitOne.commands).toEqual([
      { type: "PLAY", audioAssetId: null, ttsText: "Leave a message, greeting 3" },
      { type: "VOICEMAIL_HANDOFF" },
    ]);

    const timedOut = await advanceFlow(
      env.DB,
      "diagram_menu_test",
      "diag_menu",
      { type: "TIMEOUT_OR_INVALID" },
      false,
      0
    );
    expect(timedOut.nextNodeId).toBe("diag_wait");
    expect(timedOut.attempt).toBe(0);
    expect(timedOut.commands).toEqual([
      { type: "PLAY", audioAssetId: null, ttsText: "Please hold, you're in the queue" },
      { type: "ENQUEUE" },
    ]);
  });
});

describe("walkFromNode — resume walking from an arbitrary node id", () => {
  it("walks from a play node through to the next stop node (voicemail)", async () => {
    await insertNode({
      id: "wfn_play",
      flow: "wfn_flow",
      type: "play",
      config: { audioAssetId: null, ttsText: "Sorry we missed you", nextNodeId: "wfn_vm" },
    });
    await insertNode({
      id: "wfn_vm",
      flow: "wfn_flow",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "Leave a message", mailboxLabel: "wfn" },
    });

    const result = await walkFromNode(env.DB, "wfn_play", false);
    expect(result.nextNodeId).toBe("wfn_vm");
    expect(result.attempt).toBe(0);
    expect(result.commands).toEqual([
      { type: "PLAY", audioAssetId: null, ttsText: "Sorry we missed you" },
      { type: "PLAY", audioAssetId: null, ttsText: "Leave a message" },
      { type: "VOICEMAIL_HANDOFF" },
    ]);
  });

  it("walks from a node id that resolves straight to a stop node (a ring node)", async () => {
    await insertNode({
      id: "wfn_ring",
      flow: "wfn_flow_2",
      type: "ring",
      config: { target: "all", strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "wfn_vm2" },
    });

    const result = await walkFromNode(env.DB, "wfn_ring", false);
    expect(result.nextNodeId).toBe("wfn_ring");
    expect(result.attempt).toBe(0);
    expect(result.commands).toEqual([{ type: "DIAL_HANDOFF" }]);
  });
});

describe("advanceFlow — malformed/missing data throws a clear error", () => {
  it("throws when currentNodeId does not resolve to any row", async () => {
    await expect(
      advanceFlow(env.DB, "main", "does_not_exist", { type: "DIGIT", digit: "1" }, false, 0)
    ).rejects.toThrow(/no ivr_nodes row found/i);
  });

  it("throws when a flow has no entry node", async () => {
    await expect(advanceFlow(env.DB, "totally_unseeded_flow", null, { type: "ENTER" }, false, 0)).rejects.toThrow(
      /no entry node found/i
    );
  });

  it("throws when ENTER is used with a non-null currentNodeId", async () => {
    await expect(
      advanceFlow(env.DB, "main", "main_entry_gather", { type: "ENTER" }, false, 0)
    ).rejects.toThrow(/ENTER event requires currentNodeId to be null/i);
  });

  it("throws when DIGIT/TIMEOUT_OR_INVALID is used with a null currentNodeId", async () => {
    await expect(advanceFlow(env.DB, "main", null, { type: "TIMEOUT_OR_INVALID" }, false, 0)).rejects.toThrow(
      /requires a non-null currentNodeId/i
    );
  });

  it("throws when DIGIT/TIMEOUT_OR_INVALID targets a non-gather node", async () => {
    await expect(
      advanceFlow(env.DB, "main", "main_ring_operator", { type: "DIGIT", digit: "1" }, false, 0)
    ).rejects.toThrow(/not "gather"/i);
  });

  it("throws on invalid JSON in a node's config", async () => {
    await env.DB.prepare(
      "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("broken_config", "broken_flow", 1, "gather", "{not valid json", NOW, NOW)
      .run();

    await expect(advanceFlow(env.DB, "broken_flow", null, { type: "ENTER" }, false, 0)).rejects.toThrow(
      /malformed config JSON/i
    );
  });

  it("throws when a business_hours node is missing the branch it needs", async () => {
    await insertNode({
      id: "bh_missing_branch",
      flow: "bh_missing_branch_flow",
      isEntry: true,
      type: "business_hours",
      config: { openNextNodeId: "somewhere" }, // closedNextNodeId missing
    });

    await expect(
      advanceFlow(env.DB, "bh_missing_branch_flow", null, { type: "ENTER" }, true, 0)
    ).rejects.toThrow(/missing closedNextNodeId/i);
  });

  it("throws when a play node is missing nextNodeId", async () => {
    await insertNode({
      id: "play_missing_next",
      flow: "play_missing_next_flow",
      isEntry: true,
      type: "play",
      config: { audioAssetId: null, ttsText: "hi" },
    });

    await expect(
      advanceFlow(env.DB, "play_missing_next_flow", null, { type: "ENTER" }, false, 0)
    ).rejects.toThrow(/missing nextNodeId/i);
  });

  it("throws when a gather node has no defaultNextNodeId to fall back to once retries are exhausted", async () => {
    await insertNode({
      id: "gather_no_default",
      flow: "gather_no_default_flow",
      isEntry: true,
      type: "gather",
      config: { audioAssetId: null, ttsText: "hi", options: [], retryLimit: 0 },
    });

    await expect(
      advanceFlow(env.DB, "gather_no_default_flow", "gather_no_default", { type: "TIMEOUT_OR_INVALID" }, false, 0)
    ).rejects.toThrow(/has no defaultNextNodeId/i);
  });
});

describe("advanceFlow — business_hours node (not present in current seed data, needed for future flows)", () => {
  it("routes to openNextNodeId when isAfterHours is false, and closedNextNodeId when true", async () => {
    await insertNode({
      id: "bh_branch_test",
      flow: "bh_branch_test_flow",
      isEntry: true,
      type: "business_hours",
      config: { openNextNodeId: "bh_branch_open_vm", closedNextNodeId: "bh_branch_closed_vm" },
    });
    await insertNode({
      id: "bh_branch_open_vm",
      flow: "bh_branch_test_flow",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "open", mailboxLabel: "open" },
    });
    await insertNode({
      id: "bh_branch_closed_vm",
      flow: "bh_branch_test_flow",
      type: "voicemail",
      config: { audioAssetId: null, ttsText: "closed", mailboxLabel: "closed" },
    });

    const openResult = await advanceFlow(env.DB, "bh_branch_test_flow", null, { type: "ENTER" }, false, 0);
    expect(openResult.nextNodeId).toBe("bh_branch_open_vm");

    const closedResult = await advanceFlow(env.DB, "bh_branch_test_flow", null, { type: "ENTER" }, true, 0);
    expect(closedResult.nextNodeId).toBe("bh_branch_closed_vm");
  });
});

describe("callback node", () => {
  it("a gather option pointing at a callback node stops there and emits its prompt + CALLBACK_HANDOFF", async () => {
    await insertNode({
      id: "cb_menu",
      flow: "cbflow",
      isEntry: true,
      type: "gather",
      config: {
        audioAssetId: null,
        ttsText: "Press 1 for a callback, press 2 to hold.",
        options: [
          { digit: "1", nextNodeId: "cb_request" },
          { digit: "2", nextNodeId: "cb_hold" },
        ],
        defaultNextNodeId: "cb_hold",
        retryLimit: 0,
      },
    });
    await insertNode({
      id: "cb_request",
      flow: "cbflow",
      type: "callback",
      config: { audioAssetId: null, ttsText: "Thanks, we'll call you back soon." },
    });
    await insertNode({
      id: "cb_hold",
      flow: "cbflow",
      type: "ring",
      config: { target: "all", strategy: "simultaneous", timeoutSeconds: 20, noAnswerNextNodeId: "cb_request" },
    });

    const result = await advanceFlow(env.DB, "cbflow", "cb_menu", { type: "DIGIT", digit: "1" }, false, 0);

    expect(result.nextNodeId).toBe("cb_request");
    expect(result.commands).toEqual([
      { type: "PLAY", audioAssetId: null, ttsText: "Thanks, we'll call you back soon." },
      { type: "CALLBACK_HANDOFF" },
    ]);
  });

  // The acknowledgement is optional: with neither audio nor TTS configured the node still has to
  // hand off, so CallSession can log the request and speak its own default line.
  it("a callback node with no prompt configured still emits CALLBACK_HANDOFF alone", async () => {
    await insertNode({
      id: "cb_bare",
      flow: "cbbare",
      isEntry: true,
      type: "callback",
      config: { audioAssetId: null, ttsText: null },
    });

    const result = await advanceFlow(env.DB, "cbbare", null, { type: "ENTER" }, false, 0);

    expect(result.nextNodeId).toBe("cb_bare");
    expect(result.commands).toEqual([{ type: "CALLBACK_HANDOFF" }]);
  });
});

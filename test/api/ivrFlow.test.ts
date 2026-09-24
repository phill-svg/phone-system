import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetFlow, handleListFlows, handlePatchNodePosition, handlePutFlow } from "../../src/api/ivrFlow";
import { replaceFlowNodes } from "../../src/db/ivrNodes";

const STAFF: import("../../src/access/requireStaffUser").StaffUser = {
  email: "tech@example.com",
  role: "staff",
};
const ADMIN: import("../../src/access/requireStaffUser").StaffUser = {
  email: "admin@example.com",
  role: "admin",
};

function putRequest(body: unknown): Request {
  return new Request("https://example.com/api/ivr/flows/test_flow", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function patchPositionRequest(flow: string, nodeId: string, body: unknown): Request {
  return new Request(
    `https://example.com/api/ivr/flows/${encodeURIComponent(flow)}/nodes/${encodeURIComponent(nodeId)}/position`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  );
}

const validVoicemail = { id: "vm-1", type: "voicemail", config: { audioAssetId: null, ttsText: "leave a message", mailboxLabel: "default" } };

describe("handleGetFlow", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  it("returns entryNodeId + nodes for a flow that has nodes", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "entry-1", [
      { id: "entry-1", type: "voicemail", config: { audioAssetId: null, ttsText: "hi", mailboxLabel: "default" } },
    ]);

    const response = await handleGetFlow(env.DB, "test_flow");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entryNodeId: string; nodes: { id: string }[] };
    expect(body.entryNodeId).toBe("entry-1");
    expect(body.nodes.map((n) => n.id)).toEqual(["entry-1"]);
  });

  it("returns 404 for a flow with zero nodes", async () => {
    const response = await handleGetFlow(env.DB, "empty_flow");
    expect(response.status).toBe(404);
  });
});

describe("handlePutFlow", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  it("returns 403 for a non-admin staff user", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "vm-1", nodes: [validVoicemail] }),
      env.DB,
      "test_flow",
      STAFF
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 for a non-JSON body", async () => {
    const response = await handlePutFlow(putRequest("not json"), env.DB, "test_flow", ADMIN);
    expect(response.status).toBe(400);
  });

  it("returns 400 when a node's type is not one of the six known types", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type: "smoke_signal", config: {} }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown type");
  });

  it("returns 400 when a business_hours node's config is missing required fields", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type: "business_hours", config: { openNextNodeId: "n1" } }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid config shape");
  });

  // Redirect was the ONE type whose blank config the endpoint refused, which made "Add a step ->
  // Forward to a number" impossible from the handset: a new step is saved the instant its type is
  // picked, and its number is typed on the next screen. Every other type is allowed to exist
  // half-wired -- blank next-fields are legal by design -- so this is the inconsistency, not the
  // rule. The handset marks it unfinished (incompleteReason) instead.
  it("accepts a redirect node whose number has not been typed yet", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type: "redirect", config: { number: "" } }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("still refuses a redirect whose number is not a string at all", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type: "redirect", config: { number: 61400000000 } }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  // The message names the offending node and field, and that text is the whole point of validating
  // on write -- but it only reaches anyone if the client can read it. `apiFetch` lifts a message
  // out of a JSON {error} body and otherwise shows "request failed (400)", so a plain-text body
  // meant the handset reported nothing useful for a mistyped closed date or a missing menu key.
  it("answers a rejection with a JSON error body the client can read", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type: "smoke_signal", config: {} }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json<{ error?: string }>();
    expect(body.error).toContain("unknown type");
  });

  it("names the offending closed date in the JSON error, not just 'invalid'", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "date_rule",
            config: { closedDates: ["2026-12-25", "2026-13-01"], openNextNodeId: "", closedNextNodeId: "" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    const body = await response.json<{ error?: string }>();
    expect(body.error).toContain("2026-13-01");
  });

  // numDigits goes to <Gather numDigits> verbatim and timeoutSeconds to the ring leg's Timeout, so a
  // zero from a cleared web field used to be accepted and reach a live call.
  for (const [type, field, config] of [
    ["input", "numDigits", { audioAssetId: null, ttsText: "enter your number", nextNodeId: "" }],
    ["ring", "timeoutSeconds", { target: "all", strategy: "cascade", noAnswerNextNodeId: "" }],
  ] as const) {
    it(`refuses a ${type} node whose ${field} is not a whole number of at least 1, naming the field`, async () => {
      for (const bad of [0, -1, 1.5]) {
        const response = await handlePutFlow(
          putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type, config: { ...config, [field]: bad } }] }),
          env.DB,
          "test_flow",
          ADMIN
        );
        expect(response.status, `${field}=${bad}`).toBe(400);
        const body = await response.json<{ error?: string }>();
        expect(body.error).toContain("n1");
        expect(body.error).toContain(field);
      }
      const ok = await handlePutFlow(
        putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type, config: { ...config, [field]: 1 } }] }),
        env.DB,
        "test_flow",
        ADMIN
      );
      expect(ok.status).toBe(200);
    });
  }

  it("returns 400 when a play node's config is missing nextNodeId", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "n1", nodes: [{ id: "n1", type: "play", config: { audioAssetId: null, ttsText: "hi" } }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when a gather node's options are malformed", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "gather",
            config: {
              audioAssetId: null,
              ttsText: "press",
              options: [{ digit: "1" }], // missing nextNodeId
              defaultNextNodeId: "n1",
              retryLimit: 3,
            },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when a ring node's target is neither 'all' nor a string array", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "ring",
            config: { target: "everyone", strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "n1" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("refuses a ring node whose timeoutSeconds is over 120, naming the field and why", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "ring",
            config: { target: "all", strategy: "cascade", timeoutSeconds: 500, noAnswerNextNodeId: "n1" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ error?: string }>();
    expect(body.error).toContain("n1");
    expect(body.error).toContain("timeoutSeconds");
    const ok = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "ring",
            config: { target: "all", strategy: "cascade", timeoutSeconds: 120, noAnswerNextNodeId: "n1" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(ok.status).toBe(200);
  });

  it("accepts a ring node targeting a specific list of staff emails", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "ring",
            config: { target: ["a@b.com"], strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "n1" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("returns 400 when a ring node's target array contains a non-string entry", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "ring",
            config: { target: [123], strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "n1" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  // A wait step's callback key must be exactly one phone key: anything else could never be pressed
  // (so callbacks silently stop working) or would be read as "every digit".
  it("returns 400 when a wait node's callbackKey is not a single phone key", async () => {
    // "#" too: the hold <Gather> takes it as the finish key and posts no digits, so it could never work.
    for (const callbackKey of ["12", "x", "", 1, "#"]) {
      const res = await handlePutFlow(
        putRequest({
          entryNodeId: "w",
          nodes: [
            {
              id: "w",
              type: "wait",
              config: { audioAssetId: null, ttsText: "hold please", allowCallbackStar: true, callbackKey, nextNodeId: "n1" },
            },
          ],
        }),
        env.DB,
        "test_flow",
        ADMIN
      );
      expect(res.status, String(callbackKey)).toBe(400);
    }
  });

  // The callback line supplies only a callback step's words; aimed anywhere else it would do nothing
  // the admin meant, so it is refused on save, naming the step.
  it("refuses a hold step's callback line that leads to a step other than a callback step", async () => {
    const payload = (targetType: string) =>
      putRequest({
        entryNodeId: "w",
        nodes: [
          { id: "w", type: "wait", config: { audioAssetId: null, ttsText: "hold", allowCallbackStar: true, nextNodeId: "", callbackNextNodeId: "t" } },
          targetType === "callback"
            ? { id: "t", type: "callback", config: { audioAssetId: null, ttsText: "We will call you back." } }
            : { id: "t", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "VM" } },
        ],
      });
    const refused = await handlePutFlow(payload("voicemail"), env.DB, "test_flow", ADMIN);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("Request a callback");
    expect((await handlePutFlow(payload("callback"), env.DB, "test_flow", ADMIN)).status).toBe(200);
  });

  // Node ids are global and calls load them with no flow check, so a line into ANOTHER menu is
  // checked against that menu's step too.
  it("refuses a callback line into another menu's step that is not a callback step", async () => {
    await env.DB.prepare(
      "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, 'other_flow', 0, ?, ?, 1, 1)"
    )
      .bind("elsewhere_vm", "voicemail", JSON.stringify({ audioAssetId: null, ttsText: null, mailboxLabel: "VM" }))
      .run();
    await env.DB.prepare(
      "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, 'other_flow', 0, ?, ?, 1, 1)"
    )
      .bind("elsewhere_cb", "callback", JSON.stringify({ audioAssetId: null, ttsText: "We will call." }))
      .run();
    const payload = (target: string) =>
      putRequest({
        entryNodeId: "w",
        nodes: [
          { id: "w", type: "wait", config: { audioAssetId: null, ttsText: "hold", allowCallbackStar: true, nextNodeId: "", callbackNextNodeId: target } },
        ],
      });
    const refused = await handlePutFlow(payload("elsewhere_vm"), env.DB, "test_flow", ADMIN);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("Request a callback");
    expect((await handlePutFlow(payload("elsewhere_cb"), env.DB, "test_flow", ADMIN)).status).toBe(200);
    // A target that exists nowhere is left alone, like every other next-field.
    expect((await handlePutFlow(payload("nowhere"), env.DB, "test_flow", ADMIN)).status).toBe(200);
  });

  it("returns 400 when a wait node's callbackNextNodeId is not a string", async () => {
    const res = await handlePutFlow(
      putRequest({
        entryNodeId: "w",
        nodes: [
          {
            id: "w",
            type: "wait",
            config: { audioAssetId: null, ttsText: "hold please", allowCallbackStar: true, callbackNextNodeId: 5, nextNodeId: "" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(res.status).toBe(400);
  });

  it("accepts a wait node with a one-key callbackKey, or none", async () => {
    for (const extra of [{ callbackKey: "1" }, { callbackKey: "*" }, {}]) {
      const res = await handlePutFlow(
        putRequest({
          entryNodeId: "w",
          nodes: [
            {
              id: "w",
              type: "wait",
              config: { audioAssetId: null, ttsText: "hold please", allowCallbackStar: true, nextNodeId: "", ...extra },
            },
          ],
        }),
        env.DB,
        "test_flow",
        ADMIN
      );
      expect(res.status, JSON.stringify(extra)).toBe(200);
    }
  });

  it("returns 400 when a wait node's allowCallbackStar is not a boolean", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [
          {
            id: "n1",
            type: "wait",
            config: { audioAssetId: null, ttsText: "hold please", allowCallbackStar: "yes", nextNodeId: "n1" },
          },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when a voicemail node's config is missing mailboxLabel", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [{ id: "n1", type: "voicemail", config: { audioAssetId: null, ttsText: "leave a message" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when entryNodeId matches zero nodes in the payload", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "does-not-exist", nodes: [validVoicemail] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("must match exactly one node");
  });

  it("returns 400 when entryNodeId matches two nodes in the payload (malformed duplicate ids)", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "dup",
        nodes: [
          { id: "dup", type: "voicemail", config: { audioAssetId: null, ttsText: "a", mailboxLabel: "a" } },
          { id: "dup", type: "voicemail", config: { audioAssetId: null, ttsText: "b", mailboxLabel: "b" } },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("must match exactly one node");
  });

  it("ACCEPTS a reference within the payload to a node that doesn't exist yet (incremental building)", async () => {
    // Dangling-reference rejection was deliberately removed: a flow is built up node-by-node
    // (e.g. via the editor's "+ Add node"), and most node types require pointing at a "next"
    // node that may not have been created yet. Only the per-type shape validators (non-empty
    // string, etc.) still apply -- existence of the target is no longer checked at save time.
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [{ id: "n1", type: "play", config: { audioAssetId: null, ttsText: "hi", nextNodeId: "not-created-yet" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("ACCEPTS a reference to a node id that doesn't exist in any flow", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [{ id: "n1", type: "ring", config: { target: "all", strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "nowhere_node" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("ACCEPTS a reference to an existing node that lives in a different flow (shared node case)", async () => {
    // Seed a node that lives in a completely different flow than the one being saved --
    // this mirrors the real shared_voicemail node (flow='main') referenced by after_hours.
    await replaceFlowNodes(env.DB, "other_flow", "shared-vm", [
      { id: "shared-vm", type: "voicemail", config: { audioAssetId: null, ttsText: "shared", mailboxLabel: "shared" } },
    ]);

    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [{ id: "n1", type: "ring", config: { target: "all", strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "shared-vm" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("ACCEPTS a stale reference to a node dropped from the CURRENT flow being replaced", async () => {
    // Seed the flow being edited (test_flow) with A and B, where B references A. Then PUT a
    // payload that keeps only B (dropping A) while B's config still points at A's id -- this
    // used to be rejected as a dangling reference; now it saves, and node-a's reference simply
    // goes unresolved until either node-a is re-added or node-b is repointed.
    await replaceFlowNodes(env.DB, "test_flow", "node-b", [
      { id: "node-a", type: "voicemail", config: { audioAssetId: null, ttsText: "a", mailboxLabel: "a" } },
      { id: "node-b", type: "play", config: { audioAssetId: null, ttsText: "b", nextNodeId: "node-a" } },
    ]);

    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "node-b",
        nodes: [{ id: "node-b", type: "play", config: { audioAssetId: null, ttsText: "b", nextNodeId: "node-a" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("returns 400 naming a duplicate non-entry node id within the payload", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "y",
        nodes: [
          { id: "y", type: "voicemail", config: { audioAssetId: null, ttsText: "entry", mailboxLabel: "entry" } },
          { id: "x", type: "voicemail", config: { audioAssetId: null, ttsText: "a", mailboxLabel: "a" } },
          { id: "x", type: "voicemail", config: { audioAssetId: null, ttsText: "b", mailboxLabel: "b" } },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("duplicate node id");
    expect(text).toContain("x");
  });

  it("returns 400 when a payload node id already exists under a different flow (global PK collision)", async () => {
    await replaceFlowNodes(env.DB, "other_flow_2", "collide", [
      { id: "collide", type: "voicemail", config: { audioAssetId: null, ttsText: "elsewhere", mailboxLabel: "elsewhere" } },
    ]);

    const response = await handlePutFlow(
      putRequest({ entryNodeId: "collide", nodes: [{ id: "collide", type: "voicemail", config: { audioAssetId: null, ttsText: "here", mailboxLabel: "here" } }] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("collide");
    expect(text).toContain("different flow");
  });

  it("does NOT flag a collision when re-saving the CURRENT flow's own existing node ids (normal edit-and-resave)", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "reuse-1", [
      { id: "reuse-1", type: "voicemail", config: { audioAssetId: null, ttsText: "original", mailboxLabel: "original" } },
    ]);

    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "reuse-1",
        nodes: [{ id: "reuse-1", type: "voicemail", config: { audioAssetId: null, ttsText: "edited", mailboxLabel: "edited" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);
  });

  it("on success, replaces the flow's nodes and persists the correct is_entry flag", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n2",
        nodes: [
          { id: "n1", type: "play", config: { audioAssetId: null, ttsText: "hi", nextNodeId: "n2" } },
          { id: "n2", type: "voicemail", config: { audioAssetId: null, ttsText: "bye", mailboxLabel: "default" } },
        ],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);

    const rows = await env.DB.prepare("SELECT id, is_entry, type FROM ivr_nodes WHERE flow = ?")
      .bind("test_flow")
      .all<{ id: string; is_entry: number; type: string }>();
    const byId = Object.fromEntries(rows.results.map((r) => [r.id, r]));
    expect(byId["n1"].is_entry).toBe(0);
    expect(byId["n2"].is_entry).toBe(1);
    expect(byId["n2"].type).toBe("voicemail");
  });

  it("round-trips positionX/positionY when provided in the payload", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "vm-1",
        nodes: [{ ...validVoicemail, positionX: 10, positionY: 20 }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);

    const getResponse = await handleGetFlow(env.DB, "test_flow");
    const body = (await getResponse.json()) as { nodes: { positionX: number; positionY: number }[] };
    expect(body.nodes[0].positionX).toBe(10);
    expect(body.nodes[0].positionY).toBe(20);
  });

  it("defaults positionX/positionY to null when omitted from the payload", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "vm-1", nodes: [validVoicemail] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);

    const getResponse = await handleGetFlow(env.DB, "test_flow");
    const body = (await getResponse.json()) as { nodes: { positionX: number | null; positionY: number | null }[] };
    expect(body.nodes[0].positionX).toBeNull();
    expect(body.nodes[0].positionY).toBeNull();
  });
});

describe("handlePatchNodePosition", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  it("returns 403 for a non-admin staff user", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "n1", { positionX: 1, positionY: 2 }),
      env.DB,
      "test_flow",
      "n1",
      STAFF
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 for a non-JSON body", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "n1", "not json"),
      env.DB,
      "test_flow",
      "n1",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when positionX/positionY are not numbers", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "n1", { positionX: "1", positionY: 2 }),
      env.DB,
      "test_flow",
      "n1",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for a node id that doesn't exist in that flow", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "ghost", { positionX: 1, positionY: 2 }),
      env.DB,
      "test_flow",
      "ghost",
      ADMIN
    );
    expect(response.status).toBe(404);
  });

  it("updates position and returns {ok:true} for a real node", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "vm-1", [validVoicemail]);

    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "vm-1", { positionX: 42, positionY: 99 }),
      env.DB,
      "test_flow",
      "vm-1",
      ADMIN
    );
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT position_x, position_y FROM ivr_nodes WHERE id = ?")
      .bind("vm-1")
      .first<{ position_x: number; position_y: number }>();
    expect(row?.position_x).toBe(42);
    expect(row?.position_y).toBe(99);
  });
});

// The flow LIST is what lets the number pickers offer real menus instead of a free-text box an
// admin can typo. `hasEntry` travels with each one because a menu with no starting step cannot take
// a call — both pickers grey those out and `handleUpdateNumber` refuses them.
describe("GET /api/ivr/flows", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  async function node(id: string, flow: string, isEntry: boolean) {
    await env.DB
      .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, ?, 'voicemail', ?, 1, 1)")
      .bind(id, flow, isEntry ? 1 : 0, JSON.stringify({ audioAssetId: null, ttsText: "x", mailboxLabel: flow }))
      .run();
  }

  it("lists every flow with its node count and whether it can take a call", async () => {
    await node("n1", "main", true);
    await node("n2", "main", false);
    await node("n3", "sales", false); // no entry node

    const listed = (await (await handleListFlows(env.DB)).json()) as {
      flow: string;
      nodeCount: number;
      hasEntry: boolean;
    }[];

    expect(listed).toEqual([
      { flow: "main", nodeCount: 2, hasEntry: true },
      { flow: "sales", nodeCount: 1, hasEntry: false },
    ]);
  });

  it("returns an empty list rather than failing when no flow exists yet", async () => {
    expect(await (await handleListFlows(env.DB)).json()).toEqual([]);
  });
});

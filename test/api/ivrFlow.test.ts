import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetFlow, handlePatchNodePosition, handlePutFlow } from "../../src/api/ivrFlow";
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

  it("returns 400 naming a dangling reference within the payload", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [{ id: "n1", type: "play", config: { audioAssetId: null, ttsText: "hi", nextNodeId: "ghost-node" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("n1");
    expect(text).toContain("ghost-node");
  });

  it("returns 400 naming a dangling cross-flow reference to a node that doesn't exist anywhere", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "n1",
        nodes: [{ id: "n1", type: "ring", config: { target: "all", strategy: "cascade", timeoutSeconds: 20, noAnswerNextNodeId: "nowhere_node" } }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("nowhere_node");
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

  it("returns 400 naming a stale reference to a node dropped from the CURRENT flow being replaced", async () => {
    // Seed the flow being edited (test_flow) with A and B, where B references A. Then PUT a
    // payload that keeps only B (dropping A) while B's config still points at A's id. A's row is
    // still physically present in the DB at validation time (deletion only happens afterward,
    // inside replaceFlowNodes) -- so the fix must exclude test_flow's own rows from the
    // "does this reference resolve somewhere" fallback check, not just trust nodeExists globally.
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
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("node-b");
    expect(text).toContain("node-a");
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

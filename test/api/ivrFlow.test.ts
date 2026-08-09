import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetFlow, handlePutFlow } from "../../src/api/ivrFlow";
import { replaceFlowNodes } from "../../src/db/ivrNodes";

const STAFF: import("../../src/access/requireStaffUser").StaffUser = {
  email: "tech@example.com",
  role: "staff",
  mobile_number: null,
};
const ADMIN: import("../../src/access/requireStaffUser").StaffUser = {
  email: "admin@example.com",
  role: "admin",
  mobile_number: null,
};

function putRequest(body: unknown): Request {
  return new Request("https://example.com/api/ivr/flows/test_flow", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
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

  it("returns 400 when a ring node's target is not 'all' or 'on_call_only'", async () => {
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
});

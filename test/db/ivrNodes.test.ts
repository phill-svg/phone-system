import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listNodesForFlow, nodeExists, replaceFlowNodes } from "../../src/db/ivrNodes";

describe("ivrNodes db", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  it("replaceFlowNodes writes nodes that listNodesForFlow reads back, with is_entry set on exactly the right node", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "node-b", [
      { id: "node-a", type: "play", config: { audioAssetId: null, ttsText: "hi", nextNodeId: "node-b" } },
      { id: "node-b", type: "voicemail", config: { audioAssetId: null, ttsText: "bye", mailboxLabel: "default" } },
    ]);

    const nodes = await listNodesForFlow(env.DB, "test_flow");
    expect(nodes).toHaveLength(2);

    const nodeA = nodes.find((n) => n.id === "node-a");
    const nodeB = nodes.find((n) => n.id === "node-b");
    expect(nodeA?.isEntry).toBe(false);
    expect(nodeB?.isEntry).toBe(true);
    expect(nodeA?.type).toBe("play");
    expect(nodeA?.config).toEqual({ audioAssetId: null, ttsText: "hi", nextNodeId: "node-b" });
    expect(nodeB?.flow).toBe("test_flow");
  });

  it("replaceFlowNodes fully replaces the previous node set for that flow (delete-then-reinsert)", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "old-entry", [
      { id: "old-entry", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "old" } },
    ]);
    await replaceFlowNodes(env.DB, "test_flow", "new-entry", [
      { id: "new-entry", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "new" } },
    ]);

    const nodes = await listNodesForFlow(env.DB, "test_flow");
    expect(nodes.map((n) => n.id)).toEqual(["new-entry"]);
  });

  it("replaceFlowNodes does not touch nodes belonging to a different flow", async () => {
    await replaceFlowNodes(env.DB, "flow_a", "a-entry", [
      { id: "a-entry", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "a" } },
    ]);
    await replaceFlowNodes(env.DB, "flow_b", "b-entry", [
      { id: "b-entry", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "b" } },
    ]);

    const flowANodes = await listNodesForFlow(env.DB, "flow_a");
    expect(flowANodes.map((n) => n.id)).toEqual(["a-entry"]);
  });

  it("listNodesForFlow returns an empty array for an unknown flow", async () => {
    const nodes = await listNodesForFlow(env.DB, "does-not-exist");
    expect(nodes).toEqual([]);
  });

  it("nodeExists returns true for a node that exists (regardless of which flow it belongs to)", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "some-node", [
      { id: "some-node", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "x" } },
    ]);
    expect(await nodeExists(env.DB, "some-node")).toBe(true);
  });

  it("nodeExists returns false for an id that doesn't exist", async () => {
    expect(await nodeExists(env.DB, "totally-unknown")).toBe(false);
  });
});

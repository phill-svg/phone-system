import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isRingNodeReachingOnCall } from "../../src/ivr/onCallWiring";

async function node(id: string, type: string, config: Record<string, unknown>, isEntry = false): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, 'ah_test', ?, ?, ?, 1, 1)"
  )
    .bind(id, isEntry ? 1 : 0, type, JSON.stringify(config))
    .run();
}

// A hold step's callback line only supplies a callback step's words -- nothing is ever rung through
// it -- so a rota reachable only through it must not be reported as wired, callbacks on or off.
describe("isRingNodeReachingOnCall and a hold step's callback line", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM ivr_nodes");
    await node("oc", "ring", { target: "on_call", strategy: "simultaneous", timeoutSeconds: 15, noAnswerNextNodeId: "" });
  });

  it("does not follow the line when callbacks are on", async () => {
    await node("h", "wait", { audioAssetId: null, ttsText: "hold", allowCallbackStar: true, nextNodeId: "", callbackNextNodeId: "oc" }, true);
    expect(await isRingNodeReachingOnCall(env.DB, [["ah_test"]])).toBe(false);
  });

  it("still follows the hold step's ordinary next line", async () => {
    await node("h", "wait", { audioAssetId: null, ttsText: "hold", allowCallbackStar: true, nextNodeId: "oc", callbackNextNodeId: "" }, true);
    expect(await isRingNodeReachingOnCall(env.DB, [["ah_test"]])).toBe(true);
  });

  it("does not follow it when callbacks are off", async () => {
    await node("h", "wait", { audioAssetId: null, ttsText: "hold", allowCallbackStar: false, nextNodeId: "", callbackNextNodeId: "oc" }, true);
    expect(await isRingNodeReachingOnCall(env.DB, [["ah_test"]])).toBe(false);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getCallDetail, listCalls, listLiveCalls } from "../../src/db/calls";

async function seedCall(id: string, overrides: Partial<{ startedAt: number; status: string }> = {}) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61200000000", overrides.startedAt ?? Date.now(), overrides.status ?? "in_progress")
    .run();
}

describe("db/calls", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("listCalls returns calls newest-first, respecting the limit", async () => {
    await seedCall("CA-1", { startedAt: 1000 });
    await seedCall("CA-2", { startedAt: 2000 });
    await seedCall("CA-3", { startedAt: 3000 });

    const result = await listCalls(env.DB, 2);
    expect(result.map((c) => c.id)).toEqual(["CA-3", "CA-2"]);
  });

  it("listLiveCalls returns only in_progress calls", async () => {
    await seedCall("CA-live", { status: "in_progress" });
    await seedCall("CA-done", { status: "completed" });

    const result = await listLiveCalls(env.DB);
    expect(result.map((c) => c.id)).toEqual(["CA-live"]);
  });

  it("getCallDetail returns null for a missing call", async () => {
    expect(await getCallDetail(env.DB, "CA-missing")).toBeNull();
  });

  it("getCallDetail returns the call and its ordered events", async () => {
    await seedCall("CA-detail");
    await env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind("CA-detail", 200, "state_transition", '{"next":{"name":"MAIN_MENU"}}')
      .run();
    await env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind("CA-detail", 100, "state_transition", '{"next":{"name":"GREETING"}}')
      .run();

    const result = await getCallDetail(env.DB, "CA-detail");
    expect(result?.call.id).toBe("CA-detail");
    expect(result?.events.map((e) => e.ts)).toEqual([100, 200]);
  });
});

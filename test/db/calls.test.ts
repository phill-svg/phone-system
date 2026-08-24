import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getCallDetail,
  listCalls,
  listLiveCalls,
  updateCallMeta,
  getCallStats,
  appendCallEvent,
} from "../../src/db/calls";

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

  it("listCalls surfaces the recording/direction/mailbox columns added in migration 0005", async () => {
    await seedCall("CA-cols");
    await env.DB.prepare(
      "UPDATE calls SET recording_url = ?, recording_sid = ?, direction = ?, mailbox_label = ? WHERE id = ?"
    )
      .bind("https://api.twilio.com/rec.mp3", "RE123", "outbound", "default", "CA-cols")
      .run();

    const [call] = await listCalls(env.DB, 1);
    expect(call.recording_url).toBe("https://api.twilio.com/rec.mp3");
    expect(call.recording_sid).toBe("RE123");
    expect(call.direction).toBe("outbound");
    expect(call.mailbox_label).toBe("default");
  });

  it("seeded calls default direction to 'inbound' with null recording/mailbox fields", async () => {
    await seedCall("CA-defaults");
    const [call] = await listCalls(env.DB, 1);
    expect(call.direction).toBe("inbound");
    expect(call.recording_url).toBeNull();
    expect(call.recording_sid).toBeNull();
    expect(call.mailbox_label).toBeNull();
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

  // --- Phase 4: post-call fields + analytics ---

  it("updateCallMeta stores disposition and notes", async () => {
    await seedCall("CA-meta");
    expect(await updateCallMeta(env.DB, "CA-meta", { disposition: "New booking", notes: "Wants a quote" })).toBe(true);
    const detail = await getCallDetail(env.DB, "CA-meta");
    expect(detail?.call.disposition).toBe("New booking");
    expect(detail?.call.notes).toBe("Wants a quote");
    expect(await updateCallMeta(env.DB, "CA-missing", { disposition: "x", notes: null })).toBe(false);
  });

  it("getCallStats derives answered/voicemail/missed from the event timeline", async () => {
    const now = Date.now();
    await seedCall("CA-ans", { startedAt: now - 1000 });
    await env.DB.prepare("UPDATE calls SET ended_at = ?, direction = 'inbound' WHERE id = ?").bind(now + 60000, "CA-ans").run();
    await appendCallEvent(env.DB, "CA-ans", "answered");
    await seedCall("CA-vm", { startedAt: now - 2000 });
    await env.DB.prepare("UPDATE calls SET direction = 'inbound' WHERE id = ?").bind("CA-vm").run();
    await appendCallEvent(env.DB, "CA-vm", "voicemail_left");
    await seedCall("CA-miss", { startedAt: now - 3000 });
    await env.DB.prepare("UPDATE calls SET direction = 'inbound' WHERE id = ?").bind("CA-miss").run();
    await seedCall("CA-out", { startedAt: now - 4000 });
    await env.DB.prepare("UPDATE calls SET direction = 'outbound' WHERE id = ?").bind("CA-out").run();

    const stats = await getCallStats(env.DB, now - 10 * 60_000);
    expect(stats.total).toBe(4);
    expect(stats.inbound).toBe(3);
    expect(stats.outbound).toBe(1);
    expect(stats.answered).toBe(1);
    expect(stats.voicemail).toBe(1);
    expect(stats.missed).toBe(1);
    expect(stats.avgTalkSeconds).toBeGreaterThan(0);
  });
});

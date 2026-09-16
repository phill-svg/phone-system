import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getCallDetail,
  listCalls,
  listCallsForNumber,
  listLiveCalls,
  listVoicemails,
  updateCallMeta,
  getCallStats,
  appendCallEvent,
  parseRecordingDuration,
} from "../../src/db/calls";
import { handleListCalls } from "../../src/api/calls";

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

  // Reported live: a contact's own call history was empty despite real calls existing, because
  // `listCalls`' cap (50 by default) had been pushed past by enough OTHER calls -- the contact page
  // was filtering that capped list correctly, there was just nothing of theirs left in it.
  // listCallsForNumber must find a number's calls regardless of how many other calls exist.
  it("listCallsForNumber finds a number's calls even when listCalls' cap would have pushed them out", async () => {
    await seedCall("CA-old-dix", { startedAt: 1000 }); // "+61400000000" (seedCall's fixed number)
    // 5 more recent calls from a DIFFERENT number -- a stand-in for "enough other calls to exceed
    // the cap". seedCall always uses the same caller_number, so a raw INSERT is needed here or
    // these would match the search too and the test would prove nothing.
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(`CA-other-${i}`, "+61999999999", "+61200000000", 2000 + i, "completed")
        .run();
    }

    // With a cap smaller than the total, the old call is invisible to listCalls...
    const capped = await listCalls(env.DB, 3);
    expect(capped.map((c) => c.id)).not.toContain("CA-old-dix");

    // ...but listCallsForNumber finds it directly, unaffected by that cap.
    const forNumber = await listCallsForNumber(env.DB, "+61400000000");
    expect(forNumber.map((c) => c.id)).toEqual(["CA-old-dix"]);
  });

  it("listCallsForNumber matches on either side of the call (caller or called)", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status, direction) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind("CA-outbound", "+61261059771", "+61421022938", 1000, "completed", "outbound")
      .run();

    const result = await listCallsForNumber(env.DB, "+61421022938");
    expect(result.map((c) => c.id)).toEqual(["CA-outbound"]);
  });

  // Recents marks a missed call from these two columns, because `status` cannot answer it: Twilio
  // reports a call that rang out to voicemail as `completed`, exactly like an answered one.
  it("listCalls reports whether each call was answered, and how much timeline it has", async () => {
    await seedCall("CA-answered", { startedAt: 3000, status: "completed" });
    await seedCall("CA-rangout", { startedAt: 2000, status: "completed" });
    await seedCall("CA-notimeline", { startedAt: 1000, status: "completed" });
    await appendCallEvent(env.DB, "CA-answered", "ring_started");
    await appendCallEvent(env.DB, "CA-answered", "answered");
    await appendCallEvent(env.DB, "CA-rangout", "ring_started");
    await appendCallEvent(env.DB, "CA-rangout", "voicemail_left");

    const byId = new Map((await listCalls(env.DB)).map((c) => [c.id, c]));
    expect(byId.get("CA-answered")).toMatchObject({ answered: 1, event_count: 2 });
    // Rang out to voicemail: completed, but nobody picked up.
    expect(byId.get("CA-rangout")).toMatchObject({ answered: 0, event_count: 2 });
    // No timeline at all -- "unknown", which the app must not read as "missed".
    expect(byId.get("CA-notimeline")).toMatchObject({ answered: 0, event_count: 0 });
  });

  it("listLiveCalls returns only in_progress calls", async () => {
    await seedCall("CA-live", { status: "in_progress" });
    await seedCall("CA-done", { status: "completed" });

    const result = await listLiveCalls(env.DB);
    expect(result.map((c) => c.id)).toEqual(["CA-live"]);
  });

  it("listVoicemails returns only calls with a mailbox, newest-first, and skips deleted ones", async () => {
    await seedCall("CA-vm-old", { startedAt: 1000 });
    await seedCall("CA-vm-new", { startedAt: 3000 });
    await seedCall("CA-vm-gone", { startedAt: 4000 });
    await seedCall("CA-plain", { startedAt: 5000 });
    await env.DB.prepare("UPDATE calls SET mailbox_label = 'General' WHERE id LIKE 'CA-vm-%'").run();
    await env.DB.prepare("UPDATE calls SET deleted_at = 1 WHERE id = 'CA-vm-gone'").run();

    const result = await listVoicemails(env.DB);
    expect(result.map((c) => c.id)).toEqual(["CA-vm-new", "CA-vm-old"]);
  });

  // The web call-detail pane runs the one "was this missed?" rule on this object. Without these two
  // columns it read undefined, labelled every answered inbound call "Abandoned" and never showed a
  // missed call red -- disagreeing with the list pane beside it.
  it("getCallDetail carries the answered/event_count the missed-call rule reads", async () => {
    await seedCall("CA-detail-answered", { status: "completed" });
    await appendCallEvent(env.DB, "CA-detail-answered", "ring_started");
    await appendCallEvent(env.DB, "CA-detail-answered", "answered");
    await seedCall("CA-detail-missed", { status: "completed" });
    await appendCallEvent(env.DB, "CA-detail-missed", "ring_started");

    const answered = await getCallDetail(env.DB, "CA-detail-answered");
    expect(answered?.call).toMatchObject({ answered: 1, event_count: 2 });
    const missed = await getCallDetail(env.DB, "CA-detail-missed");
    expect(missed?.call).toMatchObject({ answered: 0, event_count: 1 });
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

describe("parseRecordingDuration", () => {
  it("parses Twilio's whole-second string", () => {
    expect(parseRecordingDuration("23")).toBe(23);
    expect(parseRecordingDuration("0")).toBe(0);
  });

  // Anything unusable must be null, so the COALESCE in the UPDATE leaves the stored value alone
  // instead of overwriting a good duration with a wrong one.
  it("returns null for absent or nonsensical values", () => {
    for (const bad of [null, undefined, "", "abc", "-5", "1.5", "NaN"]) {
      expect(parseRecordingDuration(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe("handleListCalls", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("with a number, returns that number's calls instead of the capped recent list", async () => {
    await seedCall("CA-target", { startedAt: 1000 }); // "+61400000000" (seedCall's fixed number)
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("CA-other", "+61999999999", "+61200000000", 2000, "completed")
      .run();
    const res = await handleListCalls(env.DB, "+61400000000");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-target"]);
  });

  // A contact's `phone` field can arrive in whatever shape it was typed/imported in (a leading 0,
  // no country code) -- normalizePhone is what makes that match the "+61..." form calls always
  // store, the same way it already does for contact matching.
  it("normalizes the number before matching, so a non-E.164 shape still finds the call", async () => {
    await seedCall("CA-national", { startedAt: 1000 });
    const res = await handleListCalls(env.DB, "0400 000 000");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-national"]);
  });

  it("without a number, falls back to the ordinary capped recent-calls list", async () => {
    await seedCall("CA-recent", { startedAt: 1000 });
    const res = await handleListCalls(env.DB, null);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-recent"]);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  it("has settings, calls, and call_events tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(["settings", "calls", "call_events"]));
  });

  it("seeds Phill as the first admin in staff_users", async () => {
    const row = await env.DB.prepare("SELECT role FROM staff_users WHERE email = ?")
      .bind("phill@tcbpestcontrolcanberra.com.au")
      .first<{ role: string }>();
    expect(row?.role).toBe("admin");
  });

  it("has the callback_requests table", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(["callback_requests"]));
  });

  it("adds recording_url, recording_sid, direction, mailbox_label to calls with the right defaults", async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-migration-check", "+61400000000", "+61200000000", Date.now())
      .run();

    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ?")
      .bind("CA-migration-check")
      .first<{
        recording_url: string | null;
        recording_sid: string | null;
        direction: string;
        mailbox_label: string | null;
      }>();

    expect(row?.recording_url).toBeNull();
    expect(row?.recording_sid).toBeNull();
    expect(row?.direction).toBe("inbound");
    expect(row?.mailbox_label).toBeNull();
  });

  it("indexes call_events by call_id, so the call list does not scan the table per row", async () => {
    // The plan text is the assertion: a SCAN of call_events means every call row re-reads the
    // whole table (the 2026-09-30 D1 free-tier read-limit outage).
    for (const sql of [
      "SELECT EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = 'x' AND e.event_type = 'answered')",
      "SELECT COUNT(*) FROM call_events e WHERE e.call_id = 'x'",
    ]) {
      const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + sql).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail).join(" | ");
      expect(details).toContain("idx_call_events_call_type");
      expect(details).not.toMatch(/SCAN (e|call_events)\b/);
    }
  });
});

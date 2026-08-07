import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { setBusinessHours } from "../../src/db/settings";
import type { CallSession } from "../../src/durable-objects/CallSession";

const GATHER_ACTION = "https://tcb-voip.example.workers.dev/webhooks/twilio";

function event(callSid: string, overrides: Partial<{ from: string; to: string; digits: string | null }> = {}) {
  return new Request("https://internal/events", {
    method: "POST",
    body: JSON.stringify({
      callSid,
      from: overrides.from ?? "+61400000000",
      to: overrides.to ?? "+61200000000",
      digits: overrides.digits ?? null,
      webhookUrl: GATHER_ACTION,
    }),
  });
}

describe("CallSession", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare("DELETE FROM call_events").run();
    await setBusinessHours(env.DB, {
      mon: { open: "00:00", close: "23:59" },
      tue: { open: "00:00", close: "23:59" },
      wed: { open: "00:00", close: "23:59" },
      thu: { open: "00:00", close: "23:59" },
      fri: { open: "00:00", close: "23:59" },
      sat: { open: "00:00", close: "23:59" },
      sun: { open: "00:00", close: "23:59" },
    });
  });

  it("first webhook for a call answers with the disclosure and main menu in one TwiML document", async () => {
    const id = env.CALL_SESSION.idFromName("CA-abc");
    const stub = env.CALL_SESSION.get(id);
    const response = await runInDurableObject(stub, (instance) => (instance as unknown as CallSession).fetch(event("CA-abc")));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const xml = await response.text();
    expect(xml).toContain("This call may be recorded");
    expect(xml).toContain("<Gather");
    expect(xml).toContain(`action="${GATHER_ACTION}"`);

    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind("CA-abc").first();
    expect(row).toMatchObject({ id: "CA-abc", caller_number: "+61400000000", called_number: "+61200000000" });

    const events = await env.DB.prepare("SELECT event_type FROM call_events WHERE call_id = ?").bind("CA-abc").all();
    expect(events.results.length).toBe(2); // CALL_INITIATED then GREETING_SPOKEN
  });

  it("digit 1 routes to ROUTE_STAFF, updates ivr_path, and hangs up (staff ring is a later phase)", async () => {
    const id = env.CALL_SESSION.idFromName("CA-def");
    const stub = env.CALL_SESSION.get(id);
    // Each Response returned across the runInDurableObject RPC boundary must have its body
    // drained before the next call, or the underlying DO SQLite handle stays open and Windows
    // teardown of isolated storage fails with EBUSY (see task-8-report.md for the diagnosis).
    const first = await runInDurableObject(stub, (instance) => (instance as unknown as CallSession).fetch(event("CA-def")));
    await first.text();
    const response = await runInDurableObject(stub, (instance) => (instance as unknown as CallSession).fetch(event("CA-def", { digits: "1" })));

    const xml = await response.text();
    expect(xml).toContain("<Hangup/>");

    const row = await env.DB.prepare("SELECT ivr_path FROM calls WHERE id = ?").bind("CA-def").first();
    expect(row).toMatchObject({ ivr_path: "new_booking" });
  });

  it("three consecutive gather timeouts fall through to voicemail and hang up", async () => {
    const id = env.CALL_SESSION.idFromName("CA-ghi");
    const stub = env.CALL_SESSION.get(id);
    // See the drain note in the previous test: each intermediate Response body must be
    // consumed before issuing the next runInDurableObject call.
    const r1 = await runInDurableObject(stub, (instance) => (instance as unknown as CallSession).fetch(event("CA-ghi"))); // attempt 1
    await r1.text();
    const r2 = await runInDurableObject(stub, (instance) => (instance as unknown as CallSession).fetch(event("CA-ghi", { digits: null }))); // -> attempt 2
    await r2.text();
    const r3 = await runInDurableObject(stub, (instance) => (instance as unknown as CallSession).fetch(event("CA-ghi", { digits: null }))); // -> attempt 3
    await r3.text();
    const response = await runInDurableObject(stub, (instance) =>
      (instance as unknown as CallSession).fetch(event("CA-ghi", { digits: null }))
    ); // -> voicemail

    const xml = await response.text();
    expect(xml).toContain("leave a message");
    expect(xml).toContain("<Hangup/>");

    const row = await env.DB.prepare("SELECT ivr_path FROM calls WHERE id = ?").bind("CA-ghi").first();
    expect(row).toMatchObject({ ivr_path: "voicemail" });
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMissedCallSmsIfDue } from "../../src/api/missedCallSms";
import { setMissedCallSms } from "../../src/db/settings";
import { appendCallEvent } from "../../src/db/calls";

// The US1 key pair is a worker SECRET, absent from test bindings -- filled in directly, same as
// test/api/messages.test.ts.
const SMS_ENV = {
  ...env,
  TWILIO_US1_API_KEY_SID: "SK-test",
  TWILIO_US1_API_KEY_SECRET: "secret",
} as never;

function stubTwilio(response: () => Response) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("twilio.com") ? Promise.resolve(response()) : realFetch(input as RequestInfo, init)
  );
}

async function insertCall(id: string, opts: { direction?: string; caller?: string } = {}) {
  await env.DB.prepare("INSERT INTO calls (id, caller_number, called_number, started_at, direction) VALUES (?, ?, ?, ?, ?)")
    .bind(id, opts.caller ?? "+61400000000", "+61200000000", Date.now(), opts.direction ?? "inbound")
    .run();
}

describe("sendMissedCallSmsIfDue", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM messages").run();
    await env.DB.prepare("DELETE FROM settings").run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing when the setting is disabled", async () => {
    await setMissedCallSms(env.DB, { enabled: false, template: "sorry we missed you" });
    await insertCall("CA-off");
    await appendCallEvent(env.DB, "CA-off", "ring_started");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-should-not-send" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-off");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-off").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE id = 'SM-should-not-send'").first()).toBeNull();
  });

  it("does nothing for a call that was answered", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-answered");
    await appendCallEvent(env.DB, "CA-answered", "ring_started");
    await appendCallEvent(env.DB, "CA-answered", "answered");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-should-not-send" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-answered");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-answered").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
  });

  // A caller who hangs up during the greeting/IVR never reached a ring, so is not "missed" in the
  // sense this feature is for -- and would otherwise text every wrong number and hang-up.
  it("does nothing for a call that never reached a ring", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-no-ring");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-should-not-send" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-no-ring");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-no-ring").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
  });

  // Outbound calls (call-via-mobile, a staff member ringing a number) are not a customer we missed.
  it("does nothing for an outbound call", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-outbound", { direction: "outbound" });
    await appendCallEvent(env.DB, "CA-outbound", "ring_started");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-should-not-send" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-outbound");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-outbound").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
  });

  it("sends the configured template and records it in the caller's thread", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "Sorry we missed you!" });
    await insertCall("CA-missed", { caller: "+61411222333" });
    await appendCallEvent(env.DB, "CA-missed", "ring_started");
    let sentTo: string | null = null;
    let sentBody: string | null = null;
    stubTwilio(() => {
      return new Response(JSON.stringify({ sid: "SM-missed-1" }), { status: 201 });
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("twilio.com")) {
        const body = new URLSearchParams(init?.body as string);
        sentTo = body.get("To");
        sentBody = body.get("Body");
        return Promise.resolve(new Response(JSON.stringify({ sid: "SM-missed-1" }), { status: 201 }));
      }
      return realFetch(input as RequestInfo, init);
    });

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-missed");

    expect(sentTo).toBe("+61411222333");
    expect(sentBody).toBe("Sorry we missed you!");

    const call = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-missed").first<{ missed_sms_sent_at: number | null }>();
    expect(call?.missed_sms_sent_at).toBeGreaterThan(0);

    const message = await env.DB.prepare("SELECT peer_number, direction, body FROM messages WHERE id = 'SM-missed-1'").first<{
      peer_number: string;
      direction: string;
      body: string;
    }>();
    expect(message?.peer_number).toBe("+61411222333");
    expect(message?.direction).toBe("outbound");
    expect(message?.body).toBe("Sorry we missed you!");
  });

  // The claim happens AFTER a successful send, not before -- a Twilio failure must not permanently
  // mark the call as texted with nothing actually sent.
  it("does not claim the call when the Twilio send fails, so a caller is never marked texted for a message that never went out", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-fail");
    await appendCallEvent(env.DB, "CA-fail", "ring_started");
    stubTwilio(() => new Response("boom", { status: 500 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-fail");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-fail").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
  });

  it("never double-sends: a second call for the same call id is a no-op", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-once");
    await appendCallEvent(env.DB, "CA-once", "ring_started");
    let sendCount = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("twilio.com")) {
        sendCount++;
        return Promise.resolve(new Response(JSON.stringify({ sid: `SM-once-${sendCount}` }), { status: 201 }));
      }
      return realFetch(input as RequestInfo, init);
    });

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-once");
    await sendMissedCallSmsIfDue(SMS_ENV, "CA-once");

    expect(sendCount).toBe(1);
  });

  it("does nothing when SMS credentials are not configured", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-unconfigured");
    await appendCallEvent(env.DB, "CA-unconfigured", "ring_started");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-should-not-send" }), { status: 201 }));

    await sendMissedCallSmsIfDue(env as never, "CA-unconfigured");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-unconfigured").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
  });
});

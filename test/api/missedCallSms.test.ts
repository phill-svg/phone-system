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

  // The live bug this whole file exists to catch: reported as "sms not working if they request a
  // call back or leave a voicemail". A caller whose ring round times out and gets rescued from a
  // staff member's own carrier voicemail (async AMD, see CallSession.handleAmdStatus) ALSO gets a
  // real `answered` event -- Twilio reports the leg as answered before the AMD verdict is known --
  // so the plain "ring_started AND NOT answered" rule wrongly treated every one of these as
  // answered and skipped it, even though the caller then left a voicemail with nobody ever picking
  // up. `voicemail_left` and `callback_requested` are decisive on their own regardless of what else
  // happened on the call.
  it("sends even when an 'answered' event exists, if the caller left a voicemail", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-rescued-vm");
    await appendCallEvent(env.DB, "CA-rescued-vm", "ring_started");
    await appendCallEvent(env.DB, "CA-rescued-vm", "answered");
    await appendCallEvent(env.DB, "CA-rescued-vm", "mobile_machine_answered");
    await appendCallEvent(env.DB, "CA-rescued-vm", "voicemail_left");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-rescued-vm" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-rescued-vm");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-rescued-vm").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeGreaterThan(0);
  });

  it("sends when the caller requested a callback, even with no ring at all", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-cb-no-ring");
    await appendCallEvent(env.DB, "CA-cb-no-ring", "callback_requested");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-cb" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-cb-no-ring");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-cb-no-ring").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeGreaterThan(0);
  });

  it("sends when the caller left a voicemail with no ring at all", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-vm-no-ring");
    await appendCallEvent(env.DB, "CA-vm-no-ring", "voicemail_left");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-vm" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-vm-no-ring");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-vm-no-ring").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeGreaterThan(0);
  });

  // The rescue path (see above) logs `no_answer` with this reason even when the caller hangs up
  // right after being pulled out, before recording anything -- no voicemail_left, but still someone
  // TCB never actually talked to.
  it("sends when the rescue fires but the caller hangs up before leaving a message", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-rescued-hangup");
    await appendCallEvent(env.DB, "CA-rescued-hangup", "ring_started");
    await appendCallEvent(env.DB, "CA-rescued-hangup", "answered");
    await appendCallEvent(env.DB, "CA-rescued-hangup", "mobile_machine_answered");
    await appendCallEvent(env.DB, "CA-rescued-hangup", "no_answer", { reason: "mobile_voicemail_answered" });
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-rescued-hangup" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-rescued-hangup");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-rescued-hangup").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeGreaterThan(0);
  });

  // A PLAIN no_answer (no reason -- the ordinary ring-timeout case) must not be confused with the
  // rescue's reason-qualified one.
  it("does not send for a plain no_answer alongside an unrelated answered event", async () => {
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-plain-no-answer");
    await appendCallEvent(env.DB, "CA-plain-no-answer", "ring_started");
    await appendCallEvent(env.DB, "CA-plain-no-answer", "no_answer");
    await appendCallEvent(env.DB, "CA-plain-no-answer", "answered");
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-should-not-send" }), { status: 201 }));

    await sendMissedCallSmsIfDue(SMS_ENV, "CA-plain-no-answer");

    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?").bind("CA-plain-no-answer").first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeNull();
  });

  // Reported live: the text arrived while the caller was still on the phone. A caller who leaves a
  // voicemail or asks for a callback has `calls.ended_at` stamped by CallSession on the `<Record>`
  // action -- mid-call, with "Thanks, goodbye" still to play -- and the send used to be made from
  // there, because the status webhook's own send sat inside the `ended_at IS NULL` write that had
  // by then changed 0 rows.
  //
  // The webhook is now the only sender, and it must run even though that write changes nothing.
  // The worker handler is called DIRECTLY rather than through SELF.fetch, because the US1 key pair
  // is a worker secret absent from the test bindings and mutating the imported `env` does not reach
  // the worker SELF.fetch runs -- a test written that way passes with the send never executed.
  it("the status webhook still texts a caller whose call was already marked ended mid-IVR", async () => {
    const worker = (await import("../../src/worker")).default;
    await setMissedCallSms(env.DB, { enabled: true, template: "sorry we missed you" });
    await insertCall("CA-vm-then-status", { caller: "+61411222444" });
    await appendCallEvent(env.DB, "CA-vm-then-status", "voicemail_left");
    // Exactly what the `<Record>` action handler leaves behind: the call is already over as far as
    // the row is concerned, so the webhook's UPDATE below will change 0 rows.
    await env.DB.prepare("UPDATE calls SET status = 'completed', ended_at = ? WHERE id = ?")
      .bind(Date.now(), "CA-vm-then-status")
      .run();

    let sentTo: string | null = null;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      // Messages.json specifically: the webhook also calls cleanupLoneConference afterwards, which
      // is another twilio.com request with no body -- capturing on the host alone overwrote this
      // with null and the test failed against working code.
      if (String(input).includes("/Messages.json")) {
        sentTo = new URLSearchParams(String(init?.body)).get("To");
        return Promise.resolve(new Response(JSON.stringify({ sid: "SM-vm-then-status" }), { status: 201 }));
      }
      if (String(input).includes("twilio.com")) {
        return Promise.resolve(new Response(JSON.stringify({ conferences: [] }), { status: 200 }));
      }
      return realFetch(input as RequestInfo, init);
    });

    const webhookEnv = {
      ...env,
      TWILIO_US1_API_KEY_SID: "SK-test",
      TWILIO_US1_API_KEY_SECRET: "secret",
      TWILIO_WEBHOOK_SECRET: "wh-test",
    } as never;
    const response = await worker.fetch(
      new Request("https://example.com/webhooks/twilio/status?whsec=wh-test", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CA-vm-then-status", CallStatus: "completed" }).toString(),
      }),
      webhookEnv,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never
    );
    expect(response.status).toBe(200);

    expect(sentTo).toBe("+61411222444");
    const row = await env.DB.prepare("SELECT missed_sms_sent_at FROM calls WHERE id = ?")
      .bind("CA-vm-then-status")
      .first<{ missed_sms_sent_at: number | null }>();
    expect(row?.missed_sms_sent_at).toBeGreaterThan(0);
  });
});

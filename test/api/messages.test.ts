import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSendMessage } from "../../src/api/messages";

// The US1 key pair is a worker SECRET, so it is absent from the test bindings and the route would
// answer "SMS is not configured" before reaching anything worth testing. The handler is called
// directly with a filled-in env instead.
const SEND_ENV = {
  ...env,
  TWILIO_US1_API_KEY_SID: "SK-test",
  TWILIO_US1_API_KEY_SECRET: "secret",
} as never;

function sendRequest(body: Record<string, unknown>): Request {
  return new Request("https://example.com/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Sending is TWO operations that fail differently: Twilio accepting the message, and us recording
// that it did. They used to share one try/catch, so the second failing was reported as the first.
describe("handleSendMessage", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM messages").run();
  });
  afterEach(() => vi.unstubAllGlobals());

  function stubTwilio(response: () => Response) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("twilio.com") ? Promise.resolve(response()) : realFetch(input as RequestInfo, init)
    );
  }

  it("sends and records the message", async () => {
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-ok" }), { status: 201 }));
    const res = await handleSendMessage(sendRequest({ to: "0412345678", body: "on my way" }), SEND_ENV);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id, status FROM messages WHERE id = 'SM-ok'").first();
    expect(row).not.toBeNull();
  });

  // Twilio has accepted by this point -- the customer IS going to receive it. Answering "Could not
  // send" makes staff resend and the customer get it twice; and with no row, the status callback
  // for this sid is a permanent no-op, so it never appears in the thread either.
  it("reports success once Twilio has accepted, even if the row cannot be written", async () => {
    stubTwilio(() => new Response(JSON.stringify({ sid: "SM-accepted" }), { status: 201 }));
    await env.DB.exec("ALTER TABLE messages RENAME TO messages_hidden");
    try {
      const res = await handleSendMessage(sendRequest({ to: "0412345678", body: "on my way" }), SEND_ENV);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: "SM-accepted" });
    } finally {
      await env.DB.exec("ALTER TABLE messages_hidden RENAME TO messages");
    }
  });

  // sendSms only throws on !res.ok, so a 2xx with no sid would fall through the split try/catch as
  // a success with no id -- the very thing splitting it risked turning silent.
  it("reports a 2xx that carries no sid as a failure", async () => {
    stubTwilio(() => new Response(JSON.stringify({}), { status: 201 }));
    const res = await handleSendMessage(sendRequest({ to: "0412345678", body: "on my way" }), SEND_ENV);
    expect(res.status).toBe(502);
  });

  it("still reports a real send failure as one", async () => {
    stubTwilio(() => new Response("boom", { status: 500 }));
    const res = await handleSendMessage(sendRequest({ to: "0412345678", body: "on my way" }), SEND_ENV);
    expect(res.status).toBe(502);
  });
});

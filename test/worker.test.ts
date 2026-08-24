import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { setCallBlocklist } from "../src/db/settings";

describe("worker health check", () => {
  it("responds 200 ok on GET /health", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("GET /", () => {
  it("redirects to /admin/live", async () => {
    const response = await SELF.fetch("https://example.com/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin/live");
  });
});

describe("POST /webhooks/twilio", () => {
  async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  it("rejects a request with an invalid signature", async () => {
    const response = await SELF.fetch("https://example.com/webhooks/twilio", {
      method: "POST",
      headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1", From: "+61400000000", To: "+61200000000" }).toString(),
    });
    expect(response.status).toBe(401);
  });

  it("accepts a validly signed initial call and forwards it to CallSession", async () => {
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    const url = "https://example.com/webhooks/twilio";
    const params = { CallSid: "CA-xyz", From: "+61400000002", To: "+61200000000" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const xml = await response.text();
    expect(xml).toContain("<Gather");

    const row = await env.DB.prepare("SELECT id FROM calls WHERE id = ?").bind("CA-xyz").first();
    expect(row).toBeTruthy();
  });

  it("rejects a call from a blocklisted number before it reaches the CallSession DO", async () => {
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    await setCallBlocklist(env.DB, ["+61400000099"]);
    const url = "https://example.com/webhooks/twilio";
    const params = { CallSid: "CA_blocked", From: "+61400000099", To: "+61899999999" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<Reject/>");

    const call = await env.DB.prepare("SELECT 1 FROM calls WHERE id = ?").bind("CA_blocked").first();
    expect(call).toBeNull();

    await env.DB.prepare("DELETE FROM settings").run();
  });
});

describe("POST /webhooks/twilio/status", () => {
  async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  it("marks a call completed on a terminal CallStatus", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-status-1", "+61400000000", "+61200000000", Date.now())
      .run();

    const url = "https://example.com/webhooks/twilio/status";
    const params = { CallSid: "CA-status-1", CallStatus: "completed" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT status, ended_at FROM calls WHERE id = ?")
      .bind("CA-status-1")
      .first<{ status: string; ended_at: number | null }>();
    expect(row?.status).toBe("completed");
    expect(row?.ended_at).toBeGreaterThan(0);
  });

  it("does not update on a non-terminal CallStatus", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-status-2", "+61400000001", "+61200000000", Date.now())
      .run();

    const url = "https://example.com/webhooks/twilio/status";
    const params = { CallSid: "CA-status-2", CallStatus: "ringing" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

    const row = await env.DB.prepare("SELECT status, ended_at FROM calls WHERE id = ?")
      .bind("CA-status-2")
      .first<{ status: string; ended_at: number | null }>();
    expect(row?.status).toBe("in_progress");
    expect(row?.ended_at).toBeNull();
  });

  it("rejects an invalid signature", async () => {
    const response = await SELF.fetch("https://example.com/webhooks/twilio/status", {
      method: "POST",
      headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA-x", CallStatus: "completed" }).toString(),
    });
    expect(response.status).toBe(401);
  });
});

describe("Task 8 queue/ring webhook routes", () => {
  // Twilio signs the FULL request URL (including any query string) plus the sorted POST params.
  async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  async function postSigned(url: string, params: Record<string, string>) {
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);
    return SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  beforeEach(async () => {
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  // Belt-and-suspenders: if a test below stubs global fetch (see the agent-answer route) and an
  // assertion throws before its own cleanup runs, this still restores the real fetch afterward so
  // the stub can never leak into a later test in this file.
  afterEach(() => vi.unstubAllGlobals());

  // ---- Route 1: /webhooks/twilio/hold (caller leg) ----
  describe("POST /webhooks/twilio/hold", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch("https://example.com/webhooks/twilio/hold", {
        method: "POST",
        headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CA-hold-1" }).toString(),
      });
      expect(response.status).toBe(401);
    });

    it("forwards a validly-signed hold poll to CallSession as text/xml", async () => {
      const response = await postSigned("https://example.com/webhooks/twilio/hold", { CallSid: "CA-hold-1" });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/xml");
    });
  });

  // ---- Route 2: /webhooks/twilio/hold-digit (caller leg) ----
  describe("POST /webhooks/twilio/hold-digit", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch("https://example.com/webhooks/twilio/hold-digit", {
        method: "POST",
        headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CA-hd-1", Digits: "*" }).toString(),
      });
      expect(response.status).toBe(401);
    });

    it("forwards a validly-signed hold digit to CallSession as text/xml", async () => {
      const response = await postSigned("https://example.com/webhooks/twilio/hold-digit", {
        CallSid: "CA-hd-1",
        Digits: "*",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/xml");
    });
  });

  // ---- Route 3: /webhooks/twilio/queue-left (caller leg) ----
  describe("POST /webhooks/twilio/queue-left", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch("https://example.com/webhooks/twilio/queue-left", {
        method: "POST",
        headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CA-ql-1", QueueResult: "hangup" }).toString(),
      });
      expect(response.status).toBe(401);
    });

    it("forwards a validly-signed queue-left event to CallSession as text/xml", async () => {
      const response = await postSigned("https://example.com/webhooks/twilio/queue-left", {
        CallSid: "CA-ql-1",
        QueueResult: "bridged",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/xml");
    });
  });

  // ---- Route 4: /webhooks/twilio/agent-answer (staff leg, callSid from query) ----
  describe("POST /webhooks/twilio/agent-answer", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch(
        "https://example.com/webhooks/twilio/agent-answer?callSid=CA-caller-1",
        {
          method: "POST",
          headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ CallSid: "CA-staff-1" }).toString(),
        }
      );
      expect(response.status).toBe(401);
    });

    it("returns 400 when the callSid query param is missing (even with a valid signature)", async () => {
      // Sign the exact URL fetched (no query string) so we pass signature and reach the 400 branch.
      const response = await postSigned("https://example.com/webhooks/twilio/agent-answer", {
        CallSid: "CA-staff-1",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("missing callSid");
    });

    it("forwards a validly-signed agent answer (callSid from query) to CallSession as text/xml", async () => {
      // Task 4: handleAgentAnswer now REST-redirects the caller's leg (a real outbound fetch to
      // api.twilio.com) before rendering TwiML. Stub it out so this route test stays a pure
      // routing/signature check rather than a live Twilio API call.
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await postSigned(
        "https://example.com/webhooks/twilio/agent-answer?callSid=CA-caller-1",
        { CallSid: "CA-staff-1" }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/xml");
    });
  });

  // ---- Route 5: /webhooks/twilio/agent-status (staff leg, callSid from query) ----
  describe("POST /webhooks/twilio/agent-status", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch(
        "https://example.com/webhooks/twilio/agent-status?callSid=CA-caller-1",
        {
          method: "POST",
          headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ CallSid: "CA-staff-1", CallStatus: "completed" }).toString(),
        }
      );
      expect(response.status).toBe(401);
    });

    it("returns 400 when the callSid query param is missing (even with a valid signature)", async () => {
      const response = await postSigned("https://example.com/webhooks/twilio/agent-status", {
        CallSid: "CA-staff-1",
        CallStatus: "completed",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("missing callSid");
    });

    it("forwards a validly-signed agent status (callSid from query) to CallSession as text/xml", async () => {
      const response = await postSigned(
        "https://example.com/webhooks/twilio/agent-status?callSid=CA-caller-1",
        { CallSid: "CA-staff-1", CallStatus: "no-answer" }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/xml");
    });
  });

  // ---- Route 6: /webhooks/twilio/recording-status (direct D1 write, callSid from query) ----
  describe("POST /webhooks/twilio/recording-status", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch(
        "https://example.com/webhooks/twilio/recording-status?callSid=CA-rec-1",
        {
          method: "POST",
          headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ RecordingUrl: "https://api.twilio.com/rec.mp3", RecordingSid: "RE1" }).toString(),
        }
      );
      expect(response.status).toBe(401);
    });

    it("returns 400 when the callSid query param is missing (even with a valid signature)", async () => {
      const response = await postSigned("https://example.com/webhooks/twilio/recording-status", {
        RecordingUrl: "https://api.twilio.com/rec.mp3",
        RecordingSid: "RE1",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("missing callSid");
    });

    it("writes the recording url/sid directly to the calls row and returns ok", async () => {
      // NOTE: recording_url / recording_sid columns are added in Task 10. This test is written to be
      // ready but will only go green after Task 10's migration exists (see task-8 report).
      await env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
      )
        .bind("CA-rec-1", "+61400000000", "+61200000000", Date.now())
        .run();

      const response = await postSigned(
        "https://example.com/webhooks/twilio/recording-status?callSid=CA-rec-1",
        { RecordingUrl: "https://api.twilio.com/rec.mp3", RecordingSid: "RE123" }
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");

      const row = await env.DB.prepare("SELECT recording_url, recording_sid FROM calls WHERE id = ?")
        .bind("CA-rec-1")
        .first<{ recording_url: string; recording_sid: string }>();
      expect(row?.recording_url).toBe("https://api.twilio.com/rec.mp3");
      expect(row?.recording_sid).toBe("RE123");
    });
  });

  // ---- Route 7: /webhooks/twilio/join-conference (caller-leg redirect target, Task 4) ----
  describe("POST /webhooks/twilio/join-conference", () => {
    it("rejects an invalid signature with 401", async () => {
      const response = await SELF.fetch(
        "https://example.com/webhooks/twilio/join-conference?conf=CAcaller",
        {
          method: "POST",
          headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ CallSid: "CAcaller" }).toString(),
        }
      );
      expect(response.status).toBe(401);
    });

    it("returns 400 when the conf query param is missing (even with a valid signature)", async () => {
      const response = await postSigned("https://example.com/webhooks/twilio/join-conference", {
        CallSid: "CAcaller",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("missing conf");
    });

    it("returns a Dial/Conference document naming the conf query param", async () => {
      const response = await postSigned(
        "https://example.com/webhooks/twilio/join-conference?conf=CAcaller",
        { CallSid: "CAcaller" }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/xml");
      const xml = await response.text();
      // Ringback (not silence) plays while the first participant waits; no join beep.
      expect(xml).toContain(
        '<Conference region="au1" beep="false" waitUrl="https://phone.tcbpestcontrolcanberra.com.au/media/system/ringback.mp3">CAcaller</Conference>'
      );
    });
  });
});

// ---- Task 7: /webhooks/twilio/transfer-answer (transfer target's answer webhook) ----
describe("POST /webhooks/twilio/transfer-answer", () => {
  async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  async function postSigned(url: string, params: Record<string, string>) {
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);
    return SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  beforeEach(() => {
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
  });

  it("rejects an invalid signature with 401", async () => {
    const response = await SELF.fetch(
      "https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller",
      {
        method: "POST",
        headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CA-transfer-1" }).toString(),
      }
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 when the conf query param is missing (even with a valid signature)", async () => {
    const response = await postSigned("https://example.com/webhooks/twilio/transfer-answer", {
      CallSid: "CA-transfer-1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("missing conf");
  });

  it("returns a Dial/Conference document naming the conf query param", async () => {
    const response = await postSigned(
      "https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller",
      { CallSid: "CA-transfer-1" }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const xml = await response.text();
    expect(xml).toContain("<Conference");
    expect(xml).toContain("CAcaller</Conference>");
  });
});

// ---- Task 8: /twiml/voice-app (softphone outbound dialing) ----
describe("POST /twiml/voice-app", () => {
  async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  async function postSigned(url: string, params: Record<string, string>) {
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);
    return SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  beforeEach(async () => {
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare("DELETE FROM softphone_call_legs").run();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("POST /twiml/voice-app returns Conference TwiML for the agent leg and dials the target into the same conference", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sid: "CAtarget" }), { status: 200 })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postSigned("https://example.com/twiml/voice-app", {
      CallSid: "CAagent",
      From: "client:a@b.com",
      To: "+61400000000",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Conference");
    expect(body).toContain(">CAagent</Conference>");
  });

  it("inserts a calls row for the outbound leg so it shows up in Call History/Live Calls and the recording callback has a row to match", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sid: "CAtarget" }), { status: 200 })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postSigned("https://example.com/twiml/voice-app", {
      CallSid: "CAagent",
      From: "client:a@b.com",
      To: "+61400000000",
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = 'CAagent'").first<{
      caller_number: string;
      called_number: string;
      status: string;
      direction: string;
    }>();
    expect(row).toBeTruthy();
    expect(row!.direction).toBe("outbound");
    expect(row!.status).toBe("in_progress");
    expect(row!.caller_number).toBe(env.TWILIO_FROM_NUMBER);
    expect(row!.called_number).toBe("+61400000000");
  });

  it("records a softphone_call_legs row for the agent's own leg so hold/transfer can later verify ownership", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sid: "CAtarget" }), { status: 200 })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postSigned("https://example.com/twiml/voice-app", {
      CallSid: "CAagent",
      From: "client:a@b.com",
      To: "+61400000000",
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM softphone_call_legs WHERE call_sid = 'CAagent'").first<{
      call_sid: string;
      staff_email: string;
      conference_name: string;
    }>();
    expect(row).toMatchObject({
      call_sid: "CAagent",
      staff_email: "a@b.com", // "client:" prefix stripped
      conference_name: "CAagent",
    });
  });
});

describe("GET /api/me and /api/calls*", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("GET /api/me returns the dev-mode staff identity", async () => {
    const response = await SELF.fetch("https://example.com/api/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "phill@tcbpestcontrolcanberra.com.au",
      role: "admin",
    });
  });

  it("GET /api/calls returns call summaries newest-first", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-api-1", "+61400000000", "+61200000000", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-api-2", "+61400000001", "+61200000000", 2000)
      .run();

    const response = await SELF.fetch("https://example.com/api/calls");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-api-2", "CA-api-1"]);
  });

  it("GET /api/calls/live returns only in-progress calls", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'completed')"
    )
      .bind("CA-api-done", "+61400000000", "+61200000000", Date.now() - 1000)
      .run();
    // Must be recent: listLiveCalls only counts calls started in the last 3h as live.
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'in_progress')"
    )
      .bind("CA-api-live", "+61400000001", "+61200000000", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/api/calls/live");
    const body = (await response.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-api-live"]);
  });

  it("GET /api/calls/:id returns the call detail with its events", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-api-detail", "+61400000000", "+61200000000", 1000)
      .run();

    const response = await SELF.fetch("https://example.com/api/calls/CA-api-detail");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { call: { id: string }; events: unknown[] };
    expect(body.call.id).toBe("CA-api-detail");
    expect(body.events).toEqual([]);
  });

  it("GET /api/calls/:id returns 404 for a missing call", async () => {
    const response = await SELF.fetch("https://example.com/api/calls/CA-nope");
    expect(response.status).toBe(404);
  });
});

describe("GET/PUT /api/settings/*", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("GET /api/settings/business-hours returns the default schedule", async () => {
    const response = await SELF.fetch("https://example.com/api/settings/business-hours");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mon: unknown };
    expect(body.mon).toEqual({ open: "07:00", close: "17:00" });
  });

  it("PUT /api/settings/business-hours saves a new schedule", async () => {
    const schedule = {
      mon: { open: "08:00", close: "16:00" },
      tue: { open: "08:00", close: "16:00" },
      wed: { open: "08:00", close: "16:00" },
      thu: { open: "08:00", close: "16:00" },
      fri: { open: "08:00", close: "16:00" },
      sat: null,
      sun: null,
    };
    const putResponse = await SELF.fetch("https://example.com/api/settings/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(schedule),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await SELF.fetch("https://example.com/api/settings/business-hours");
    expect(await getResponse.json()).toEqual(schedule);
  });

  it("GET /api/settings/call-blocklist returns an empty list by default", async () => {
    const response = await SELF.fetch("https://example.com/api/settings/call-blocklist");
    expect(await response.json()).toEqual([]);
  });

  it("PUT /api/settings/call-blocklist saves entries", async () => {
    const list = ["+61400000000"];
    await SELF.fetch("https://example.com/api/settings/call-blocklist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(list),
    });
    const getResponse = await SELF.fetch("https://example.com/api/settings/call-blocklist");
    expect(await getResponse.json()).toEqual(list);
  });

  it("PUT /api/settings/business-hours rejects a malformed schedule shape and leaves storage unchanged", async () => {
    const malformed = {
      // missing "mon" key entirely
      tue: { open: "08:00", close: "16:00" },
      wed: { open: "08:00", close: "16:00" },
      thu: { open: "08:00", close: "16:00" },
      fri: { open: "08:00", close: "16:00" },
      sat: null,
      sun: null,
    };
    const putResponse = await SELF.fetch("https://example.com/api/settings/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malformed),
    });
    expect(putResponse.status).toBe(400);

    const getResponse = await SELF.fetch("https://example.com/api/settings/business-hours");
    const body = (await getResponse.json()) as { mon: unknown };
    expect(body.mon).toEqual({ open: "07:00", close: "17:00" });
  });

  it("PUT /api/settings/business-hours rejects a day value that isn't an open/close object or null", async () => {
    const malformed = {
      mon: "always open",
      tue: { open: "08:00", close: "16:00" },
      wed: { open: "08:00", close: "16:00" },
      thu: { open: "08:00", close: "16:00" },
      fri: { open: "08:00", close: "16:00" },
      sat: null,
      sun: null,
    };
    const putResponse = await SELF.fetch("https://example.com/api/settings/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malformed),
    });
    expect(putResponse.status).toBe(400);
  });

  it("PUT /api/settings/business-hours returns 400 (not 500) for a non-JSON body", async () => {
    const putResponse = await SELF.fetch("https://example.com/api/settings/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(putResponse.status).toBe(400);
  });

  it("PUT /api/settings/call-blocklist rejects an array containing a non-string", async () => {
    const malformed = ["+61400000000", 5];
    const putResponse = await SELF.fetch("https://example.com/api/settings/call-blocklist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malformed),
    });
    expect(putResponse.status).toBe(400);

    const getResponse = await SELF.fetch("https://example.com/api/settings/call-blocklist");
    expect(await getResponse.json()).toEqual([]);
  });
});

describe("GET /admin/calls and /admin/calls/:id", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("renders the call history list", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, ivr_path) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("CA-html-1", "+61400000000", "+61200000000", Date.now(), "new_booking")
      .run();

    const response = await SELF.fetch("https://example.com/admin/calls");
    expect(response.status).toBe(200);
    const html = await response.text();
    // Numbers render in AU national grouped form (formatAuNumber), not raw E.164.
    expect(html).toContain("0400 000 000");
    expect(html).toContain('href="/admin/calls/CA-html-1"');
  });

  it("renders the call detail page with the recording player, transcript, and disposition/notes when present", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, recording_url, recording_sid, transcription, disposition, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "CA-html-2",
        "+61400000000",
        "+61200000000",
        Date.now(),
        "https://api.twilio.com/rec.mp3",
        "RE123",
        "Please call me back about a booking.",
        "New booking",
        "Wants a quote",
      )
      .run();

    const response = await SELF.fetch("https://example.com/admin/calls/CA-html-2");
    expect(response.status).toBe(200);
    const html = await response.text();
    // Recording plays inline via the authed proxy, not a raw Twilio link.
    expect(html).toContain("/api/calls/CA-html-2/recording");
    expect(html).toContain("<audio");
    expect(html).toContain("Please call me back about a booking.");
    expect(html).toContain("New booking");
    expect(html).toContain("Wants a quote");
    expect(html).not.toContain("Not available yet");
  });

  it("404s for a missing call detail page", async () => {
    const response = await SELF.fetch("https://example.com/admin/calls/CA-nope");
    expect(response.status).toBe(404);
  });

  it("HTML-escapes the call ID in the href on the list page", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-test'call", "+61400000000", "+61200000000", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/calls");
    expect(response.status).toBe(200);
    const html = await response.text();
    // The ID contains ', which encodeURIComponent leaves unescaped (not in its encoding set),
    // then escapeHtml converts to &#39;, proving that escapeHtml actually ran.
    expect(html).toContain('href="/admin/calls/CA-test&#39;call"');
  });

  it("returns 404 for malformed URL-encoded call ID in /admin/calls/:id", async () => {
    const response = await SELF.fetch("https://example.com/admin/calls/%zz");
    expect(response.status).toBe(404);
  });
});

describe("GET /admin/settings", () => {
  it("renders the business hours form with current values and the call blocklist editor", async () => {
    const response = await SELF.fetch("https://example.com/admin/settings");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="business-hours-form"');
    expect(html).toContain('value="07:00"');
    expect(html).toContain('id="blocklist-form"');
  });
});

describe("GET /admin/live", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("renders in-progress calls with a Listen link into the muted conference join", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'in_progress')"
    )
      .bind("CA-live-1", "+61400000000", "+61200000000", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/live");
    expect(response.status).toBe(200);
    const html = await response.text();
    // Numbers render in AU national grouped form (formatAuNumber), not raw E.164.
    expect(html).toContain("0400 000 000");
    // Listen-in is live for admins: link joins the call's conference muted via the softphone.
    expect(html).toContain('href="/admin/phone?listen=CA-live-1"');
  });

  it("shows an empty-state message when nothing is in progress", async () => {
    const response = await SELF.fetch("https://example.com/admin/live");
    const html = await response.text();
    expect(html).toContain("No calls in progress");
  });
});

describe("GET /api/calls/:id with malformed URL encoding", () => {
  it("returns 404 for malformed URL-encoded call ID", async () => {
    const response = await SELF.fetch("https://example.com/api/calls/%zz");
    expect(response.status).toBe(404);
  });
});

describe("POST/GET /api/ivr/audio and public GET /media/:key", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_audio_assets").run();
  });

  it("uploads an audio file, storing it in R2 and a matching row in D1", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "greeting.mp3", { type: "audio/mpeg" });
    const form = new FormData();
    form.set("file", file);
    form.set("label", "Main greeting");

    const uploadResponse = await SELF.fetch("https://example.com/api/ivr/audio", {
      method: "POST",
      body: form,
    });
    expect(uploadResponse.status).toBe(201);
    const { id } = (await uploadResponse.json()) as { id: string };
    expect(typeof id).toBe("string");

    const row = await env.DB.prepare(
      "SELECT label, r2_key, content_type FROM ivr_audio_assets WHERE id = ?"
    )
      .bind(id)
      .first<{ label: string; r2_key: string; content_type: string }>();
    expect(row?.label).toBe("Main greeting");
    expect(row?.content_type).toBe("audio/mpeg");
    expect(row?.r2_key).toContain("/"); // key deliberately has a nested path (e.g. ivr-audio/<uuid>)

    const stored = await env.AUDIO_ASSETS.get(row!.r2_key);
    expect(stored).not.toBeNull();
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it("defaults the label to the uploaded filename when no label field is given", async () => {
    const file = new File([new Uint8Array([9])], "no-label.wav", { type: "audio/wav" });
    const form = new FormData();
    form.set("file", file);

    const uploadResponse = await SELF.fetch("https://example.com/api/ivr/audio", {
      method: "POST",
      body: form,
    });
    const { id } = (await uploadResponse.json()) as { id: string };

    const row = await env.DB.prepare("SELECT label FROM ivr_audio_assets WHERE id = ?")
      .bind(id)
      .first<{ label: string }>();
    expect(row?.label).toBe("no-label.wav");
  });

  it("returns 400 when the file field is missing", async () => {
    const form = new FormData();
    form.set("label", "no file here");

    const response = await SELF.fetch("https://example.com/api/ivr/audio", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
  });

  it("GET /api/ivr/audio lists uploaded assets", async () => {
    const file = new File([new Uint8Array([1])], "a.mp3", { type: "audio/mpeg" });
    const form = new FormData();
    form.set("file", file);
    await SELF.fetch("https://example.com/api/ivr/audio", { method: "POST", body: form });

    const listResponse = await SELF.fetch("https://example.com/api/ivr/audio");
    expect(listResponse.status).toBe(200);
    const body = (await listResponse.json()) as { label: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].label).toBe("a.mp3");
  });

  it("GET /media/:key streams the right bytes and content-type for a known key, with a long Cache-Control", async () => {
    const file = new File([new Uint8Array([5, 6, 7])], "ring.mp3", { type: "audio/mpeg" });
    const form = new FormData();
    form.set("file", file);
    const uploadResponse = await SELF.fetch("https://example.com/api/ivr/audio", {
      method: "POST",
      body: form,
    });
    const { id } = (await uploadResponse.json()) as { id: string };
    const row = await env.DB.prepare("SELECT r2_key FROM ivr_audio_assets WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string }>();

    // r2_key contains a nested path (e.g. "ivr-audio/<uuid>") -- confirm the route
    // handles the extra slash rather than treating "ivr-audio" as the whole key.
    const mediaResponse = await SELF.fetch(`https://example.com/media/${row!.r2_key}`);
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(mediaResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    expect(Array.from(bytes)).toEqual([5, 6, 7]);
  });

  it("GET /media/:key returns 404 for an unknown key", async () => {
    const response = await SELF.fetch("https://example.com/media/ivr-audio/does-not-exist");
    expect(response.status).toBe(404);
  });

  it("GET /media/:key succeeds with no Access/staff-auth header, even while /api/ requires one", async () => {
    // The whole vitest pool is configured with AUTH_MODE: "dev" (see vitest.config.ts),
    // which makes requireStaffUser bypass real Access checks everywhere -- so hitting
    // SELF.fetch("/api/...") with no headers would misleadingly succeed too, and
    // wouldn't prove /media/ is special. To get a genuine production-auth env (no dev
    // bypass, a real Cf-Access-Jwt-Assertion requirement), invoke the worker's fetch
    // handler directly with a custom env, the same technique test/access/requireStaffUser.test.ts
    // uses -- reusing the real DB/AUDIO_ASSETS bindings but overriding the auth vars.
    const file = new File([new Uint8Array([42])], "noauth.mp3", { type: "audio/mpeg" });
    const form = new FormData();
    form.set("file", file);
    const uploadResponse = await SELF.fetch("https://example.com/api/ivr/audio", {
      method: "POST",
      body: form,
    });
    const { id } = (await uploadResponse.json()) as { id: string };
    const row = await env.DB.prepare("SELECT r2_key FROM ivr_audio_assets WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string }>();

    const prodEnv = {
      DB: env.DB,
      AUDIO_ASSETS: env.AUDIO_ASSETS,
      CALL_SESSION: env.CALL_SESSION,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      // No AUTH_MODE / DEV_STAFF_EMAIL: this is what production actually looks like.
      CF_ACCESS_TEAM_DOMAIN: "tcb-pest.cloudflareaccess.com",
      CF_ACCESS_AUD: "prod-aud-tag",
    };

    // Sanity check: under this env, /api/ genuinely demands a Cf-Access-Jwt-Assertion header.
    const apiResponse = await worker.fetch(
      new Request("https://example.com/api/ivr/audio"),
      prodEnv as any
    );
    expect(apiResponse.status).toBe(401);

    // Same request, same complete absence of any auth header/cookie, against /media/:key --
    // this must succeed, proving the route carries no staff-auth gate of its own.
    const mediaResponse = await worker.fetch(
      new Request(`https://example.com/media/${row!.r2_key}`),
      prodEnv as any
    );
    expect(mediaResponse.status).toBe(200);
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    expect(Array.from(bytes)).toEqual([42]);

    // Same no-auth, no-dev-bypass env: an unknown key still 404s rather than, say,
    // erroring out or falling through to some other handler.
    const missingResponse = await worker.fetch(
      new Request("https://example.com/media/ivr-audio/does-not-exist"),
      prodEnv as any
    );
    expect(missingResponse.status).toBe(404);
  });
});

describe("Task 12 IVR flow editor routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  it("GET /admin/ivr/:flow renders node cards for the flow's nodes", async () => {
    await env.DB.prepare(
      "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, 1, 'voicemail', ?, ?, ?)"
    )
      .bind("wt-entry", "worker_test_flow", JSON.stringify({ audioAssetId: null, ttsText: "hi", mailboxLabel: "default" }), Date.now(), Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/ivr/worker_test_flow");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("wt-entry");
    // The canvas editor renders nodes client-side from embedded JSON, inside #ivrCanvas.
    expect(html).toContain('id="ivrCanvas"');
  });

  it("GET /api/ivr/flows/:flow returns the flow's entryNodeId + nodes", async () => {
    await env.DB.prepare(
      "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, 1, 'voicemail', ?, ?, ?)"
    )
      .bind("wt-entry-2", "worker_test_flow", JSON.stringify({ audioAssetId: null, ttsText: "hi", mailboxLabel: "default" }), Date.now(), Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/api/ivr/flows/worker_test_flow");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entryNodeId: string; nodes: { id: string }[] };
    expect(body.entryNodeId).toBe("wt-entry-2");
    expect(body.nodes.map((n) => n.id)).toEqual(["wt-entry-2"]);
  });

  it("PUT /api/ivr/flows/:flow saves a new flow and GET reflects it (happy path through the dev-mode admin identity)", async () => {
    const putResponse = await SELF.fetch("https://example.com/api/ivr/flows/worker_test_flow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryNodeId: "wt-put",
        nodes: [{ id: "wt-put", type: "voicemail", config: { audioAssetId: null, ttsText: "hi", mailboxLabel: "default" } }],
      }),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await SELF.fetch("https://example.com/api/ivr/flows/worker_test_flow");
    const body = (await getResponse.json()) as { entryNodeId: string };
    expect(body.entryNodeId).toBe("wt-put");
  });

  it("PUT /api/ivr/flows/:flow accepts a reference to a node that doesn't exist yet (incremental building)", async () => {
    const putResponse = await SELF.fetch("https://example.com/api/ivr/flows/worker_test_flow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryNodeId: "wt-bad",
        nodes: [{ id: "wt-bad", type: "play", config: { audioAssetId: null, ttsText: "hi", nextNodeId: "ghost" } }],
      }),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await SELF.fetch("https://example.com/api/ivr/flows/worker_test_flow");
    expect(getResponse.status).toBe(200);
  });

  it("routes /api/ivr/flows/:flow through the regex correctly, not swallowed by /api/ivr/audio", async () => {
    // "flows" and "audio" are disjoint path segments under /api/ivr/, but confirm directly
    // that a PUT to /api/ivr/flows/xyz reaches handlePutFlow, not handleUploadAudioAsset
    // (which would 400 on a JSON body since it expects multipart formData).
    const response = await SELF.fetch("https://example.com/api/ivr/flows/worker_test_flow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryNodeId: "wt-route",
        nodes: [{ id: "wt-route", type: "voicemail", config: { audioAssetId: null, ttsText: "hi", mailboxLabel: "default" } }],
      }),
    });
    expect(response.status).toBe(200);
  });

  it("requires staff auth for both new routes in a genuine production-shaped env (no dev bypass)", async () => {
    const prodEnv = {
      DB: env.DB,
      AUDIO_ASSETS: env.AUDIO_ASSETS,
      CALL_SESSION: env.CALL_SESSION,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      CF_ACCESS_TEAM_DOMAIN: "tcb-pest.cloudflareaccess.com",
      CF_ACCESS_AUD: "prod-aud-tag",
    };

    const adminPageResponse = await worker.fetch(
      new Request("https://example.com/admin/ivr/worker_test_flow"),
      prodEnv as any
    );
    expect(adminPageResponse.status).toBe(302);
    expect(adminPageResponse.headers.get("Location")).toBe("/login");

    const apiResponse = await worker.fetch(
      new Request("https://example.com/api/ivr/flows/worker_test_flow"),
      prodEnv as any
    );
    expect(apiResponse.status).toBe(401);
  });

  it("GET /admin/ivr/:flow returns 404 for malformed URL-encoded flow name", async () => {
    const response = await SELF.fetch("https://example.com/admin/ivr/%zz");
    expect(response.status).toBe(404);
  });
});

describe("Task 13 callback-requests routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM callback_requests").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("GET /api/callback-requests returns open callback requests", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-cbr-1", "+61400000000", "+61200000000", Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
      .bind("CA-cbr-1", "+61400000000", 1000)
      .run();

    const response = await SELF.fetch("https://example.com/api/callback-requests");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { call_id: string }[];
    expect(body.map((r) => r.call_id)).toEqual(["CA-cbr-1"]);
  });

  it("GET /admin/callbacks renders without erroring, including the empty state", async () => {
    const response = await SELF.fetch("https://example.com/admin/callbacks");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Callback Requests");
    expect(html).toContain("No open callback requests");
  });

  it("GET /admin/callbacks renders a seeded open request", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-cbr-2", "+61400000009", "+61200000000", Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
      .bind("CA-cbr-2", "+61400000009", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/callbacks");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("+61400000009");
  });

  it("requires staff auth for both new routes in a genuine production-shaped env (no dev bypass)", async () => {
    const prodEnv = {
      DB: env.DB,
      AUDIO_ASSETS: env.AUDIO_ASSETS,
      CALL_SESSION: env.CALL_SESSION,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      CF_ACCESS_TEAM_DOMAIN: "tcb-pest.cloudflareaccess.com",
      CF_ACCESS_AUD: "prod-aud-tag",
    };

    const apiResponse = await worker.fetch(
      new Request("https://example.com/api/callback-requests"),
      prodEnv as any
    );
    expect(apiResponse.status).toBe(401);

    const adminResponse = await worker.fetch(
      new Request("https://example.com/admin/callbacks"),
      prodEnv as any
    );
    expect(adminResponse.status).toBe(302);
    expect(adminResponse.headers.get("Location")).toBe("/login");
  });
});

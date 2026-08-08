import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("worker health check", () => {
  it("responds 200 ok on GET /health", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
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

describe("GET /api/me and /api/calls*", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("GET /api/me returns the dev-mode staff identity", async () => {
    const response = await SELF.fetch("https://example.com/api/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" });
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
      .bind("CA-api-done", "+61400000000", "+61200000000", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'in_progress')"
    )
      .bind("CA-api-live", "+61400000001", "+61200000000", 2000)
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

  it("GET /api/settings/staff-ring-list returns an empty list by default", async () => {
    const response = await SELF.fetch("https://example.com/api/settings/staff-ring-list");
    expect(await response.json()).toEqual([]);
  });

  it("PUT /api/settings/staff-ring-list saves entries", async () => {
    const list = [{ label: "Phill", number: "+61400000000" }];
    await SELF.fetch("https://example.com/api/settings/staff-ring-list", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(list),
    });
    const getResponse = await SELF.fetch("https://example.com/api/settings/staff-ring-list");
    expect(await getResponse.json()).toEqual(list);
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
    expect(html).toContain("+61400000000");
    expect(html).toContain('href="/admin/calls/CA-html-1"');
  });

  it("renders the call detail page with a disabled recording/transcript placeholder", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-html-2", "+61400000000", "+61200000000", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/calls/CA-html-2");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Not available yet");
    expect(html).toContain("disabled");
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
  it("renders the business hours form with current values and the ring list editor", async () => {
    const response = await SELF.fetch("https://example.com/admin/settings");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="business-hours-form"');
    expect(html).toContain('value="07:00"');
    expect(html).toContain('id="ring-list-form"');
  });
});

describe("GET /api/calls/:id with malformed URL encoding", () => {
  it("returns 404 for malformed URL-encoded call ID", async () => {
    const response = await SELF.fetch("https://example.com/api/calls/%zz");
    expect(response.status).toBe(404);
  });
});

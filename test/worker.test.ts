import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

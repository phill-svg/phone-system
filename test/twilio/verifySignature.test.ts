import { describe, expect, it } from "vitest";
import { verifyTwilioSignature } from "../../src/twilio/verifySignature";

const AUTH_TOKEN = "test-auth-token";
const OTHER_AUTH_TOKEN = "other-region-auth-token";

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

describe("verifyTwilioSignature", () => {
  const url = "https://example.com/webhooks/twilio";
  const params = { CallSid: "CA123", From: "+61400000000", To: "+61200000000", CallStatus: "ringing" };

  it("accepts a correctly signed request", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, signature, [AUTH_TOKEN])).toBe(true);
  });

  it("rejects a tampered param value", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    const tampered = { ...params, From: "+61499999999" };
    expect(await verifyTwilioSignature(url, tampered, signature, [AUTH_TOKEN])).toBe(false);
  });

  it("rejects a signature computed with the wrong auth token", async () => {
    const signature = await sign(url, params, "wrong-token");
    expect(await verifyTwilioSignature(url, params, signature, [AUTH_TOKEN])).toBe(false);
  });

  it("rejects a signature computed for a different URL", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    expect(await verifyTwilioSignature("https://example.com/other", params, signature, [AUTH_TOKEN])).toBe(false);
  });

  it("is independent of the params object's key order", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    const reordered = { To: params.To, CallStatus: params.CallStatus, From: params.From, CallSid: params.CallSid };
    expect(await verifyTwilioSignature(url, reordered, signature, [AUTH_TOKEN])).toBe(true);
  });

  it("rejects when the only auth token is empty, even with an otherwise well-formed signature", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, signature, [""])).toBe(false);
  });

  it("accepts a request signed with the SECOND candidate token (multi-region accounts sign with different tokens depending on which region processed the request)", async () => {
    const signature = await sign(url, params, OTHER_AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, signature, [AUTH_TOKEN, OTHER_AUTH_TOKEN])).toBe(true);
  });

  it("rejects when the signature matches neither candidate token", async () => {
    const signature = await sign(url, params, "wrong-token");
    expect(await verifyTwilioSignature(url, params, signature, [AUTH_TOKEN, OTHER_AUTH_TOKEN])).toBe(false);
  });

  it("skips blank candidate tokens rather than throwing", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, signature, ["", AUTH_TOKEN])).toBe(true);
  });
});

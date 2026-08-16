import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createSession, lookupSession, destroySession, destroySessionsForEmail,
  parseSessionCookie, sessionCookieHeader, parseBearerToken,
} from "../../src/access/session";
import { sha256Hex } from "../../src/access/crypto";

const EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("sessions", () => {
  it("creates a session and looks it up by raw token", async () => {
    const token = await createSession(env.DB, EMAIL);
    expect(await lookupSession(env.DB, token)).toBe(EMAIL);
  });

  it("returns null for an unknown or destroyed token", async () => {
    expect(await lookupSession(env.DB, "nope")).toBeNull();
    const token = await createSession(env.DB, EMAIL);
    await destroySession(env.DB, token);
    expect(await lookupSession(env.DB, token)).toBeNull();
  });

  it("destroySessionsForEmail kills all of a user's sessions", async () => {
    const t1 = await createSession(env.DB, EMAIL);
    const t2 = await createSession(env.DB, EMAIL);
    await destroySessionsForEmail(env.DB, EMAIL);
    expect(await lookupSession(env.DB, t1)).toBeNull();
    expect(await lookupSession(env.DB, t2)).toBeNull();
  });

  it("parseSessionCookie extracts the token; header sets flags", () => {
    const req = new Request("https://x/", { headers: { Cookie: "a=1; tcb_session=abc.def; b=2" } });
    expect(parseSessionCookie(req)).toBe("abc.def");
    const header = sessionCookieHeader("tok");
    expect(header).toContain("tcb_session=tok");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
  });

  it("rejects a session whose expires_at is in the past", async () => {
    const token = "expired-token-raw";
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).bind(tokenHash, EMAIL, 1000, Date.now() - 1000).run();
    expect(await lookupSession(env.DB, token)).toBeNull();
  });

  it("parseBearerToken extracts the token from an Authorization header", () => {
    expect(parseBearerToken(new Request("https://x/", { headers: { Authorization: "Bearer abc.def" } }))).toBe("abc.def");
    expect(parseBearerToken(new Request("https://x/", { headers: { Authorization: "bearer XYZ" } }))).toBe("XYZ");
    expect(parseBearerToken(new Request("https://x/"))).toBeNull();
    expect(parseBearerToken(new Request("https://x/", { headers: { Authorization: "Basic abc" } }))).toBeNull();
  });
});

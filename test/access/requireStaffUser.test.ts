import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { requireStaffUser } from "../../src/access/requireStaffUser";

const TEAM_DOMAIN = "tcb-pest.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";
const KID = "test-key-req";

async function setupJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

async function signToken(privateKey: KeyLike, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, aud: [AUDIENCE], iss: `https://${TEAM_DOMAIN}`, exp: now + 3600, iat: now })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(privateKey);
}

describe("requireStaffUser", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("DELETE FROM staff_users WHERE email != ?")
      .bind("phill@tcbpestcontrolcanberra.com.au")
      .run();
  });

  it("dev mode: returns the configured dev staff user when it exists in staff_users", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev", DEV_STAFF_EMAIL: "phill@tcbpestcontrolcanberra.com.au" };
    const request = new Request("https://example.com/api/me");
    const result = await requireStaffUser(request, env as any);
    expect(result).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" });
  });

  it("dev mode: 500s if DEV_STAFF_EMAIL is not set", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev" };
    const request = new Request("https://example.com/api/me");
    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });

  it("production mode: 401s when the Cf-Access-Jwt-Assertion header is missing", async () => {
    const env = { DB: testEnv.DB, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE };
    const request = new Request("https://example.com/api/me");
    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("production mode: 500s when CF_ACCESS_TEAM_DOMAIN/AUD are not configured", async () => {
    const env = { DB: testEnv.DB };
    const request = new Request("https://example.com/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "irrelevant" },
    });
    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });

  it("production mode: verifies a real token and returns the matching staff_users role", async () => {
    const { privateKey, jwks } = await setupJwks();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(jwks)));
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: testEnv.DB, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE };
    const token = await signToken(privateKey, "phill@tcbpestcontrolcanberra.com.au");
    const request = new Request("https://example.com/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });

    const result = await requireStaffUser(request, env as any);
    expect(result).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" });

    vi.unstubAllGlobals();
  });

  it("production mode: 403s for a verified email not in staff_users", async () => {
    const { privateKey, jwks } = await setupJwks();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(jwks)));
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: testEnv.DB, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE };
    const token = await signToken(privateKey, "unprovisioned@example.com");
    const request = new Request("https://example.com/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });

    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);

    vi.unstubAllGlobals();
  });
});

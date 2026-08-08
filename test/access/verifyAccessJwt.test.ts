import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { createAccessVerifier } from "../../src/access/verifyAccessJwt";

const TEAM_DOMAIN = "tcb-pest.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";
const KID = "test-key-1";

async function setupJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

async function signToken(privateKey: KeyLike, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: KID }).sign(privateKey);
}

describe("createAccessVerifier", () => {
  const fetchMock = vi.fn();
  let privateKey: KeyLike;
  let jwks: { keys: JWK[] };

  beforeEach(async () => {
    ({ privateKey, jwks } = await setupJwks());
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(jwks), { headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts a validly signed token and lower-cases the email", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "Phill@TCBPestControlCanberra.com.au",
      aud: [AUDIENCE],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au" });
  });

  it("rejects a token with the wrong audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: ["wrong-aud"],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: [AUDIENCE],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now - 10,
      iat: now - 3600,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: [AUDIENCE],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token.slice(0, -4) + "abcd")).toBeNull();
  });

  it("rejects a token from the wrong issuer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: [AUDIENCE],
      iss: "https://someone-elses-team.cloudflareaccess.com",
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toBeNull();
  });
});

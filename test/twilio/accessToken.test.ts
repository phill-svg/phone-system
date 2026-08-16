import { describe, expect, it } from "vitest";
import { jwtVerify, decodeJwt } from "jose";
import { mintAccessToken } from "../../src/twilio/accessToken";

const base = {
  accountSid: "AC123",
  apiKeySid: "SK123",
  apiKeySecret: "secret",
  twimlAppSid: "AP123",
  identity: "a@b.com",
};

describe("mintAccessToken", () => {
  it("mints a signed JWT with the Twilio Access Token header and grants (verifiable with the API key secret)", async () => {
    const token = await mintAccessToken(base);
    const key = new TextEncoder().encode("secret");
    const { payload, protectedHeader } = await jwtVerify(token, key);

    expect(protectedHeader.cty).toBe("twilio-fpa;v=1");
    expect(payload.iss).toBe("SK123");
    expect(payload.sub).toBe("AC123");
    const grants = payload.grants as any;
    expect(grants.identity).toBe("a@b.com");
    expect(grants.voice.incoming.allow).toBe(true);
    expect(grants.voice.outgoing.application_sid).toBe("AP123");
  });

  it("omits push_credential_sid when not provided", async () => {
    const jwt = await mintAccessToken(base);
    const grants = (decodeJwt(jwt) as any).grants;
    expect("push_credential_sid" in grants.voice).toBe(false);
  });

  it("includes push_credential_sid when provided", async () => {
    const jwt = await mintAccessToken({ ...base, pushCredentialSid: "CR999" });
    const grants = (decodeJwt(jwt) as any).grants;
    expect(grants.voice.push_credential_sid).toBe("CR999");
  });
});

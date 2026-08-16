import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { mintAccessToken } from "../../src/twilio/accessToken";

const base = {
  accountSid: "AC123", apiKeySid: "SK123", apiKeySecret: "secret", twimlAppSid: "AP123", identity: "a@b.com",
};

describe("mintAccessToken", () => {
  it("omits push_credential_sid when not provided", async () => {
    const jwt = await mintAccessToken(base);
    const grants = (decodeJwt(jwt) as any).grants;
    expect(grants.identity).toBe("a@b.com");
    expect(grants.voice.outgoing.application_sid).toBe("AP123");
    expect(grants.voice.incoming.allow).toBe(true);
    expect("push_credential_sid" in grants.voice).toBe(false);
  });

  it("includes push_credential_sid when provided", async () => {
    const jwt = await mintAccessToken({ ...base, pushCredentialSid: "CR999" });
    const grants = (decodeJwt(jwt) as any).grants;
    expect(grants.voice.push_credential_sid).toBe("CR999");
  });
});

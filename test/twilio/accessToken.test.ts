import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { mintAccessToken } from "../../src/twilio/accessToken";

describe("mintAccessToken", () => {
  it("mints a JWT with the Twilio Access Token header and grants, verifiable with the API key secret", async () => {
    const token = await mintAccessToken({
      accountSid: "ACxxx",
      apiKeySid: "SKxxx",
      apiKeySecret: "shh",
      twimlAppSid: "APxxx",
      identity: "phill@tcbpestcontrolcanberra.com.au",
    });

    const key = new TextEncoder().encode("shh");
    const { payload, protectedHeader } = await jwtVerify(token, key);

    expect(protectedHeader.cty).toBe("twilio-fpa;v=1");
    expect(payload.iss).toBe("SKxxx");
    expect(payload.sub).toBe("ACxxx");
    expect((payload.grants as any).identity).toBe("phill@tcbpestcontrolcanberra.com.au");
    expect((payload.grants as any).voice.incoming.allow).toBe(true);
    expect((payload.grants as any).voice.outgoing.application_sid).toBe("APxxx");
  });
});

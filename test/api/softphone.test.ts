import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { handleGetSoftphoneToken } from "../../src/api/softphone";

describe("handleGetSoftphoneToken", () => {
  it("returns a token scoped to the requesting staff member's identity", async () => {
    const env = {
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_API_KEY_SID: "SKxxx",
      TWILIO_API_KEY_SECRET: "shh",
      TWILIO_TWIML_APP_SID: "APxxx",
    };
    const res = await handleGetSoftphoneToken(env, { email: "a@b.com", role: "staff" });
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    const { payload } = await jwtVerify(token, new TextEncoder().encode("shh"));
    expect((payload.grants as any).identity).toBe("a@b.com");
  });
});

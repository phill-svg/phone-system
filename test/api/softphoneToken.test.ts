import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { handleGetSoftphoneToken } from "../../src/api/softphone";

const env = {
  TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "s", TWILIO_TWIML_APP_SID: "AP1",
  TWILIO_PUSH_CREDENTIAL_SID_IOS: "CRios", TWILIO_PUSH_CREDENTIAL_SID_ANDROID: "CRand",
};
const staff = { email: "a@b.com", role: "staff" as const };

describe("handleGetSoftphoneToken platform push credentials", () => {
  async function grantOf(res: Response) {
    const { token } = (await res.json()) as { token: string };
    return (decodeJwt(token) as any).grants.voice;
  }
  it("no platform → no push credential", async () => {
    const voice = await grantOf(await handleGetSoftphoneToken(env as any, staff));
    expect("push_credential_sid" in voice).toBe(false);
  });
  it("platform=ios → iOS push credential", async () => {
    const voice = await grantOf(await handleGetSoftphoneToken(env as any, staff, "ios"));
    expect(voice.push_credential_sid).toBe("CRios");
  });
  it("platform=android → Android push credential", async () => {
    const voice = await grantOf(await handleGetSoftphoneToken(env as any, staff, "android"));
    expect(voice.push_credential_sid).toBe("CRand");
  });
});

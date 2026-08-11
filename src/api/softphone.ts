import { jsonResponse } from "./respond";
import { mintAccessToken } from "../twilio/accessToken";
import type { StaffUser } from "../access/requireStaffUser";

type Env = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_TWIML_APP_SID: string;
};

export async function handleGetSoftphoneToken(env: Env, staff: StaffUser): Promise<Response> {
  const token = await mintAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY_SID,
    apiKeySecret: env.TWILIO_API_KEY_SECRET,
    twimlAppSid: env.TWILIO_TWIML_APP_SID,
    identity: staff.email,
  });
  return jsonResponse({ token });
}

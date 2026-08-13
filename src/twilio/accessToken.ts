import { SignJWT } from "jose";

const TOKEN_TTL_SECONDS = 3600;

export async function mintAccessToken(opts: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
}): Promise<string> {
  const key = new TextEncoder().encode(opts.apiKeySecret);
  return new SignJWT({
    grants: {
      identity: opts.identity,
      voice: { incoming: { allow: true }, outgoing: { application_sid: opts.twimlAppSid } },
    },
  })
    // twr routes token validation to the au1 region, where this account's telephony
    // (number, TwiML app, API key signing this token) is homed.
    .setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1", twr: "au1" })
    .setIssuer(opts.apiKeySid)
    .setSubject(opts.accountSid)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS)
    .sign(key);
}

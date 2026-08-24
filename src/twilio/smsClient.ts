// SMS send via Twilio's Messages API. Unlike this account's voice (au1), the Messages endpoint is
// NOT served in the au1 realm ("Endpoint is not supported in realm 'au1'"), so SMS goes through the
// default (us1) API host -- even for the au1-homed number.
const TWILIO_API_BASE = "https://api.twilio.com";

export async function sendSms(
  accountSid: string,
  apiKeySid: string,
  apiKeySecret: string,
  opts: { to: string; from: string; body: string; statusCallback?: string }
): Promise<{ sid: string }> {
  const body = new URLSearchParams({ To: opts.to, From: opts.from, Body: opts.body });
  if (opts.statusCallback) body.set("StatusCallback", opts.statusCallback);

  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${apiKeySid}:${apiKeySecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Twilio send-SMS failed: ${res.status} ${await res.text()}`);
  const json = await res.json<{ sid: string }>();
  return { sid: json.sid };
}

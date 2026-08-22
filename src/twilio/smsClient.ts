// SMS send via Twilio's Messages API. AU1-homed like the rest of this account's REST calls
// (see restClient.ts) -- au1 endpoint, au1 API key.
const TWILIO_API_BASE = "https://api.sydney.au1.twilio.com";

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

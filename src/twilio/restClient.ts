export type OutboundCallOptions = {
  to: string;
  from: string;
  url: string;
  statusCallback?: string;
  statusCallbackEvent?: string[];
  // Ring time in seconds before Twilio gives up on an unanswered leg and fires a "no-answer"
  // status. Without it, unanswered legs ring on the carrier default (~30s+) before the flow
  // can fall through.
  timeoutSeconds?: number;
};

// The business number -- and therefore every caller leg, conference, and agent leg we attach
// to them -- is homed in Twilio's au1 (Australia) region. Regional resources are only visible
// to the regional endpoint, authenticated with au1-region credentials.
const TWILIO_API_BASE = "https://api.sydney.au1.twilio.com";

export async function createOutboundCall(
  accountSid: string,
  apiKeySid: string,
  apiKeySecret: string,
  opts: OutboundCallOptions
): Promise<{ sid: string }> {
  const body = new URLSearchParams({ To: opts.to, From: opts.from, Url: opts.url });
  if (opts.statusCallback) body.set("StatusCallback", opts.statusCallback);
  if (opts.statusCallbackEvent) body.set("StatusCallbackEvent", opts.statusCallbackEvent.join(","));
  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) body.set("Timeout", String(Math.round(opts.timeoutSeconds)));

  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${apiKeySid}:${apiKeySecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Twilio create-call failed: ${res.status} ${await res.text()}`);
  const json = await res.json<{ sid: string }>();
  return { sid: json.sid };
}

export async function cancelCall(
  accountSid: string,
  apiKeySid: string,
  apiKeySecret: string,
  callSid: string
): Promise<void> {
  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${apiKeySid}:${apiKeySecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "canceled" }),
  });
  if (!res.ok) throw new Error(`Twilio cancel-call failed: ${res.status}`);
}

export async function redirectCall(accountSid: string, authToken: string, callSid: string, url: string): Promise<void> {
  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Url: url }),
  });
  if (!res.ok) throw new Error(`Twilio redirect-call failed: ${res.status}`);
}

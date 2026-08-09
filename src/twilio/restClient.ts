export type OutboundCallOptions = {
  to: string;
  from: string;
  url: string;
  statusCallback?: string;
  statusCallbackEvent?: string[];
};

export async function createOutboundCall(
  accountSid: string,
  authToken: string,
  opts: OutboundCallOptions
): Promise<{ sid: string }> {
  const body = new URLSearchParams({ To: opts.to, From: opts.from, Url: opts.url });
  if (opts.statusCallback) body.set("StatusCallback", opts.statusCallback);
  if (opts.statusCallbackEvent) body.set("StatusCallbackEvent", opts.statusCallbackEvent.join(","));

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Twilio create-call failed: ${res.status}`);
  const json = await res.json<{ sid: string }>();
  return { sid: json.sid };
}

export async function cancelCall(accountSid: string, authToken: string, callSid: string): Promise<void> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "canceled" }),
  });
  if (!res.ok) throw new Error(`Twilio cancel-call failed: ${res.status}`);
}

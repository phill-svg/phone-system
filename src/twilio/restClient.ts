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
  // Answering-machine detection: classify the answering party as human/machine/fax. Used ONLY for
  // the pstn mobile leg (see CallSession.dialStaff) so a staff member's personal carrier voicemail
  // can't hijack a business call.
  machineDetection?: "Enable" | "DetectMessageEnd";
  // Run that detection in the BACKGROUND. Twilio's default (AsyncAmd=false) blocks the call until
  // detection finishes -- the answering party is connected but the caller keeps hearing ringback
  // for the 2-4s the classifier takes, which is exactly the "I answered but they kept ringing"
  // symptom. With AsyncAmd the legs bridge immediately and the verdict arrives later at
  // asyncAmdStatusCallback instead of as `AnsweredBy` on the answer webhook.
  asyncAmd?: boolean;
  asyncAmdStatusCallback?: string;
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
  if (opts.machineDetection) body.set("MachineDetection", opts.machineDetection);
  if (opts.asyncAmd) body.set("AsyncAmd", "true");
  if (opts.asyncAmdStatusCallback) body.set("AsyncAmdStatusCallback", opts.asyncAmdStatusCallback);

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

// End a leg that has already been ANSWERED. cancelCall's Status=canceled only works while a leg
// is still ringing, so a machine-answered mobile (which by definition answered) has to be completed
// instead. Uses the account auth token, matching redirectCall.
export async function hangupCall(accountSid: string, authToken: string, callSid: string): Promise<void> {
  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "completed" }),
  });
  if (!res.ok) throw new Error(`Twilio hangup-call failed: ${res.status}`);
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

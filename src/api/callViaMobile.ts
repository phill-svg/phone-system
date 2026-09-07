import { jsonResponse } from "./respond";
import { createOutboundCall } from "../twilio/restClient";
import { resolveSendingNumber } from "../db/phoneNumbers";
import { getUserSettings, normalizeMobileE164 } from "../db/userSettings";
import type { StaffUser } from "../access/requireStaffUser";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_FROM_NUMBER: string;
  TWILIO_WEBHOOK_SECRET?: string;
};

// The customer's number, as typed. Accepts E.164 or the AU local forms staff actually dial.
export function normalizeDialTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[\s()-]/g, "");
  if (/^0[2-9]\d{8}$/.test(digits)) return `+61${digits.slice(1)}`;
  // 13/1300/1800 carry no trunk prefix, so unlike an "02..." landline there is no leading 0 to
  // strip -- "1300 123 456" is +611300123456. Slicing here produced +61300123456, a number that
  // does not exist.
  if (/^1[38]00\d{6}$/.test(digits) || /^13\d{4}$/.test(digits)) return `+61${digits}`;
  return null;
}

// "Call via my mobile": instead of carrying the call over VoIP, Twilio rings the staff member's
// mobile and, once they answer, dials the customer showing the business number. Both legs are
// carrier calls, so the audio never depends on the phone's data connection -- which is the whole
// point -- and the native dialler handles mute/speaker/keypad, so there is no in-call UI to build.
export async function handleCallViaMobile(
  request: Request,
  env: Env,
  staff: StaffUser,
  origin: string,
  appendSecret: (url: string, secret?: string) => string
): Promise<Response> {
  let body: { to?: unknown; from?: unknown };
  try {
    body = (await request.json()) as { to?: unknown; from?: unknown };
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }

  const target = normalizeDialTarget(String(body.to ?? ""));
  if (!target) return jsonResponse({ error: "That doesn't look like a number we can dial." }, 400);

  const settings = await getUserSettings(env.DB, staff.email);
  const mobile = normalizeMobileE164(settings.mobile_number);
  if (!mobile) {
    return jsonResponse({ error: "Add your mobile number in Settings before calling via mobile." }, 400);
  }
  // Dialling yourself would bridge your mobile to itself.
  if (mobile === target) return jsonResponse({ error: "That's your own mobile number." }, 400);

  // Same caller-ID rules as the softphone dialer: honour the staff member's pick only if it is an
  // enabled voice number. It is shown to the customer AND used for the leg to your own mobile, so
  // an incoming "6105 9771" on your phone is the cue that it is the system calling you back.
  const callerId = (await resolveSendingNumber(env.DB, "voice", typeof body.from === "string" ? body.from : null)) ?? env.TWILIO_FROM_NUMBER;

  const bridgeUrl = appendSecret(
    `${origin}/twiml/mobile-bridge?to=${encodeURIComponent(target)}&callerId=${encodeURIComponent(callerId)}`,
    env.TWILIO_WEBHOOK_SECRET
  );

  const { sid } = await createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
    to: mobile,
    from: callerId,
    url: bridgeUrl,
    statusCallback: appendSecret(`${origin}/webhooks/twilio/status`, env.TWILIO_WEBHOOK_SECRET),
    statusCallbackEvent: ["completed"],
    // Short, because this leg is ringing a phone in the staff member's hand. The longer it rings
    // the likelier the carrier voicemail answers instead of them.
    timeoutSeconds: 20,
    // SYNCHRONOUS answering-machine detection -- deliberately the opposite of the inbound pstn leg,
    // where blocking makes the waiting caller hear extra ringback. Here nobody is waiting: the
    // customer has not been dialled yet. Blocking for the verdict is exactly what lets us refuse to
    // connect a customer to this staff member's voicemail, which is the one bad outcome available.
    machineDetection: "Enable",
  });

  // Keyed on the mobile leg's SID so the ordinary status webhook, call history, recording callback
  // and the ServiceM8 sweep all treat this like any other outbound call, with no special cases.
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours, status, direction) VALUES (?, ?, ?, ?, 0, 'in_progress', 'outbound')"
  )
    .bind(sid, callerId, target, Date.now())
    .run();

  return jsonResponse({ ok: true, callSid: sid, ringing: mobile, callerId });
}

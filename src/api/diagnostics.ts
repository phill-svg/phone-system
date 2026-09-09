import { jsonResponse } from "./respond";
import { listPhoneNumbers } from "../db/phoneNumbers";
import { getStaffRoster } from "../db/staff";
import { getDivertCallerId, getDivertCallerIdRejection } from "../db/settings";
import { isStaffAvailable } from "../dial/presence";
import { sendExpoPush } from "../push/expoPush";
import { sendEmail, type SendEmailBinding } from "../email/sendgrid";
import type { StaffUser } from "../access/requireStaffUser";

// Admin-only health checks, all reachable from a phone.
//
// Every one of these exists because it went wrong in production and nothing said so: the ServiceM8
// key that was never set, the ported landline that arrived in us1 and silently rejected calls at
// the network edge, invites that fail when the email binding isn't wired. A check earns its place
// here by having cost a real outage, not by being easy to write.

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { key: string; label: string; status: CheckStatus; detail: string };

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  SERVICEM8_API_KEY?: string;
  TWILIO_INTELLIGENCE_SERVICE_SID?: string;
  EMAIL?: SendEmailBinding;
};

// A check must never hang the screen. Twilio and ServiceM8 are third parties on the far side of
// the Pacific; without a bound, one of them being slow means the admin stares at a spinner.
const CHECK_TIMEOUT_MS = 8000;

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), CHECK_TIMEOUT_MS)),
  ]);
}

// Is the ServiceM8 integration actually on? "No key" and "key rejected" look identical from the
// outside -- a 401 and an absent secret both just mean nothing happens -- so they are reported
// as different things here.
async function checkServiceM8(env: Env): Promise<Check> {
  const base = { key: "servicem8", label: "ServiceM8" };
  if (!env.SERVICEM8_API_KEY) {
    return { ...base, status: "fail", detail: "No API key set. Call notes and auto-created contacts are both off." };
  }
  try {
    // A search that matches nothing is the cheapest authenticated call there is.
    const res = await withTimeout(
      fetch("https://api.servicem8.com/api_1.0/search.json?q=zzzzzzzz&limit=1", {
        headers: { "X-Api-Key": env.SERVICEM8_API_KEY, Accept: "application/json" },
      }),
      "ServiceM8"
    );
    if (res.status === 401 || res.status === 403) {
      return { ...base, status: "fail", detail: `API key rejected (${res.status}). It may have been revoked.` };
    }
    if (!res.ok) return { ...base, status: "warn", detail: `ServiceM8 answered ${res.status}.` };
    return { ...base, status: "ok", detail: "Connected. Callers are matched 3 minutes after a call ends." };
  } catch (e) {
    return { ...base, status: "fail", detail: `Couldn't reach ServiceM8: ${e instanceof Error ? e.message : "error"}` };
  }
}

// Are speaker-labelled transcripts actually on? This needs TWO things, and either being absent looks
// identical from the outside -- nothing happens and the transcript is simply unlabelled. So the two
// are reported separately, and the second is inferred from what recordings actually came back rather
// than from a setting we would only be reading back to ourselves.
//
// This check exists because the same shape of silence hid the ServiceM8 key for a full day.
async function checkCallTranscripts(env: Env): Promise<Check> {
  const base = { key: "transcripts", label: "Speaker-labelled transcripts" };
  if (!env.TWILIO_INTELLIGENCE_SERVICE_SID) {
    return {
      ...base,
      status: "warn",
      detail: "No Intelligence service set. Transcripts still work, but won't say who said what.",
    };
  }
  try {
    const row = await env.DB.prepare(
      `SELECT
         SUM(intelligence_status = 'completed')      AS done,
         SUM(intelligence_status = 'single_channel') AS mono,
         SUM(intelligence_status = 'pending')        AS pending,
         SUM(intelligence_status IN ('abandoned', 'failed')) AS stuck
       FROM calls
       WHERE intelligence_sid IS NOT NULL AND started_at > ?`
    )
      .bind(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .first<{ done: number | null; mono: number | null; pending: number | null; stuck: number | null }>();
    const done = row?.done ?? 0;
    const mono = row?.mono ?? 0;
    const pending = row?.pending ?? 0;
    const stuck = row?.stuck ?? 0;
    // Recordings coming back on one channel is the tell that the Console's dual-channel conference
    // switch is off -- the single most likely reason this is configured but not working.
    if (mono > 0 && done === 0) {
      return {
        ...base,
        status: "fail",
        detail:
          `${mono} recording(s) came back on one channel. Most likely Voice > Settings > ` +
          `Dual-channel Recording for Conference is off — but a call where only one party spoke ` +
          `looks the same, so check a recent one before changing anything.`,
      };
    }
    // Every transcript giving up is the OTHER silent failure. A transcript Twilio holds but whose
    // sentences we can never read (a sustained 5xx, or a call longer than the page cap) burns its
    // polls and lands on `abandoned` -- which used to land on `single_channel` and at least turn
    // this red, for the wrong reason. Counting it here is what stops "no alarm" being the trade.
    if (stuck > 0 && done === 0) {
      return {
        ...base,
        status: "fail",
        detail: `${stuck} transcript(s) gave up before returning any text. Check the worker logs for INTELLIGENCE_.`,
      };
    }
    if (done > 0) return { ...base, status: "ok", detail: `${done} labelled transcript(s) in the last 7 days.` };
    if (pending > 0) return { ...base, status: "ok", detail: `${pending} transcript(s) in progress.` };
    return { ...base, status: "warn", detail: "Configured, but no answered call has been transcribed yet." };
  } catch (e) {
    return { ...base, status: "warn", detail: `Couldn't check: ${e instanceof Error ? e.message : "error"}` };
  }
}

// Can we reach Twilio with the credentials we hold? If this fails, no outbound call can be placed
// and no softphone token can be minted -- the phone system is down, whatever else looks fine.
async function checkTwilioCredentials(env: Env): Promise<Check> {
  const base = { key: "twilio", label: "Twilio account" };
  try {
    const res = await withTimeout(
      fetch(`https://api.sydney.au1.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}.json`, {
        headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` },
      }),
      "Twilio"
    );
    if (res.status === 401) return { ...base, status: "fail", detail: "Twilio rejected our credentials (401)." };
    if (!res.ok) return { ...base, status: "warn", detail: `Twilio answered ${res.status}.` };
    const body = await res.json<{ status?: string; friendly_name?: string }>();
    if (body.status && body.status !== "active") {
      return { ...base, status: "fail", detail: `Account status is "${body.status}".` };
    }
    return { ...base, status: "ok", detail: `Reachable in au1${body.friendly_name ? ` — ${body.friendly_name}` : ""}.` };
  } catch (e) {
    return { ...base, status: "fail", detail: `Couldn't reach Twilio: ${e instanceof Error ? e.message : "error"}` };
  }
}

// The one that cost a whole day. A Twilio number is global but its config is per-region, and
// inbound calls are handled in whichever region its Inbound Processing Region names. If that isn't
// au1, the softphone cannot be connected to the call -- and with no voice handler there, Twilio
// rejects it at the network edge: no call log, no webhook, and the caller hears a carrier
// "not connected" intercept. /admin/settings only shows the region we RECORDED; this asks Twilio.
async function checkNumberRegions(env: Env): Promise<Check> {
  const base = { key: "regions", label: "Voice number regions" };
  const numbers = (await listPhoneNumbers(env.DB)).filter((n) => n.voice_enabled);
  if (numbers.length === 0) return { ...base, status: "warn", detail: "No voice-enabled numbers configured." };

  const wrong: string[] = [];
  const unknown: string[] = [];
  for (const number of numbers) {
    try {
      const res = await withTimeout(
        fetch(`https://routes.twilio.com/v2/PhoneNumbers/${encodeURIComponent(number.e164)}`, {
          headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` },
        }),
        "Twilio routes"
      );
      // A 404 means no explicit regional config exists, which DEFAULTS to us1 -- the trap itself.
      if (res.status === 404) {
        wrong.push(`${number.e164} (no region set — defaults to us1)`);
        continue;
      }
      if (!res.ok) {
        unknown.push(number.e164);
        continue;
      }
      const body = await res.json<{ voice_region?: string }>();
      if (body.voice_region !== "au1") wrong.push(`${number.e164} (${body.voice_region ?? "unknown"})`);
    } catch {
      unknown.push(number.e164);
    }
  }

  if (wrong.length > 0) {
    return {
      ...base,
      status: "fail",
      detail: `Not in au1: ${wrong.join(", ")}. Inbound calls to these are handled outside au1, where the softphone can't be connected. Fix on the number's Regional tab in the Twilio console.`,
    };
  }
  if (unknown.length > 0) return { ...base, status: "warn", detail: `Couldn't check: ${unknown.join(", ")}.` };
  return { ...base, status: "ok", detail: `All ${numbers.length} voice number(s) are in au1.` };
}

// Invites and password resets are the only way a staff member gets an account. When the binding
// isn't wired they fail at the send, after the user row already exists.
function checkEmail(env: Env): Check {
  const base = { key: "email", label: "Email sending" };
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return { ...base, status: "fail", detail: "No email binding. Invites and password resets can't be sent." };
  }
  return { ...base, status: "ok", detail: "Binding configured. Use Send Test Email to prove delivery." };
}

// Will an inbound call ring anybody right now? Everything else can be green while the answer is no.
async function checkRingRoster(env: Env): Promise<Check> {
  const base = { key: "roster", label: "Who's on call now" };
  const now = new Date();
  const available = (await getStaffRoster(env.DB)).filter((s) => isStaffAvailable(s, now));
  if (available.length === 0) {
    return {
      ...base,
      status: "warn",
      detail: "Nobody is on shift with a live app right now — an inbound call would go to voicemail.",
    };
  }
  return { ...base, status: "ok", detail: `${available.length} would ring: ${available.map((s) => s.email.split("@")[0]).join(", ")}.` };
}

// Push is per-device, so this reports the caller's OWN registered devices -- the question behind it
// is always "why didn't MY phone buzz".
async function checkPushTokens(env: Env, staff: StaffUser): Promise<Check> {
  const base = { key: "push", label: "Your devices" };
  const rows = await env.DB.prepare("SELECT platform, COUNT(*) AS n FROM push_tokens WHERE staff_email = ? GROUP BY platform")
    .bind(staff.email)
    .all<{ platform: string; n: number }>();
  if (rows.results.length === 0) {
    return { ...base, status: "fail", detail: "No devices registered for push. Open the app on your phone and allow notifications." };
  }
  return { ...base, status: "ok", detail: rows.results.map((r) => `${r.n} ${r.platform}`).join(", ") + " registered." };
}

// Is a diverted call actually ringing with the customer's number on it?
//
// The fallback in dialStaff is deliberately invisible -- the phone still rings and the call still
// connects, just showing the business number -- so a carrier or account rejecting the caller ID
// would otherwise be visible only in a log line nobody is tailing. Same silence that hid
// SERVICEM8_API_KEY for a day.
//
// Note what this CANNOT see: a carrier that accepts the leg from Twilio and then rewrites or drops
// the presented number downstream. Only a real test call proves that end, which is why the ok state
// says so rather than claiming more than it knows.
async function checkDivertCallerId(env: Env): Promise<Check> {
  const base = { key: "divert_caller_id", label: "Caller ID on ring-my-mobile" };
  try {
    const [enabled, rejection] = await Promise.all([getDivertCallerId(env.DB), getDivertCallerIdRejection(env.DB)]);
    if (!enabled) {
      return { ...base, status: "ok", detail: "Off — diverted calls ring from the business number." };
    }
    if (rejection && Date.now() - rejection.at < 7 * 24 * 60 * 60 * 1000) {
      return {
        ...base,
        status: "fail",
        detail:
          `Twilio rejected the customer's number as caller ID (HTTP ${rejection.status}) on ` +
          `${new Date(rejection.at).toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
          "Diverted calls are silently ringing from the business number instead.",
      };
    }
    return {
      ...base,
      status: "ok",
      detail: "On — diverted calls show the customer's number. Make one test divert to confirm your carrier honours it.",
    };
  } catch (e) {
    return { ...base, status: "warn", detail: `Couldn't check: ${e instanceof Error ? e.message : "error"}` };
  }
}

export async function handleGetDiagnostics(env: Env, staff: StaffUser): Promise<Response> {
  // The names below are POSITIONAL: each binding takes whatever the call in the same position
  // returns. Keep the two lists in the same order and the same length -- adding a call without a
  // binding silently shifts every one after it and drops the last check off the end entirely, which
  // is exactly what happened when the transcripts check was first added here.
  const [twilio, regions, roster, divert, servicem8, transcripts, push] = await Promise.all([
    checkTwilioCredentials(env),
    checkNumberRegions(env),
    checkRingRoster(env),
    checkDivertCallerId(env),
    checkServiceM8(env),
    checkCallTranscripts(env),
    checkPushTokens(env, staff),
  ]);
  // Display order, which is deliberately not the call order.
  return jsonResponse([twilio, regions, roster, divert, servicem8, transcripts, checkEmail(env), push]);
}

// End-to-end push: the only proof that the whole chain works is a phone buzzing. Deliberately sent
// only to the CALLER's own devices -- a test button that pages the whole team would not get used.
export async function handleTestPush(env: Env, staff: StaffUser): Promise<Response> {
  const rows = await env.DB.prepare("SELECT token FROM push_tokens WHERE staff_email = ?")
    .bind(staff.email)
    .all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (tokens.length === 0) {
    return jsonResponse({ error: "No devices are registered for push on your account." }, 400);
  }
  try {
    const { sent, invalidTokens } = await sendExpoPush(tokens, {
      title: "TCB Phone",
      body: "Test notification — push is working.",
      data: { type: "test" },
    });
    // Expo reports a dead token as DeviceNotRegistered; prune it here so the count staff see is the
    // number of phones that will actually buzz, not the number that ever registered.
    for (const token of invalidTokens) {
      await env.DB.prepare("DELETE FROM push_tokens WHERE token = ?").bind(token).run();
    }
    return jsonResponse({ sent, devices: tokens.length, pruned: invalidTokens.length });
  } catch (e) {
    return jsonResponse({ error: `Push failed: ${e instanceof Error ? e.message : "unknown error"}` }, 502);
  }
}

// End-to-end email, to the admin's own address for the same reason as the push above.
export async function handleTestEmail(env: Env, staff: StaffUser): Promise<Response> {
  try {
    await sendEmail(env, {
      to: staff.email,
      subject: "TCB Phone test email",
      html: "<p>This is a test from TCB Phone. If it arrived, invites and password resets will send too.</p>",
    });
    return jsonResponse({ ok: true, to: staff.email });
  } catch (e) {
    return jsonResponse({ error: `Email failed: ${e instanceof Error ? e.message : "unknown error"}` }, 502);
  }
}

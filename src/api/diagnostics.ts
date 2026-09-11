import { jsonResponse } from "./respond";
import { listPhoneNumbers } from "../db/phoneNumbers";
import { blankToNull } from "../db/calls";
import { getStaffRoster } from "../db/staff";
import { getDivertCallerId, getDivertCallerIdRejection } from "../db/settings";
import { isStaffAvailable } from "../dial/presence";
import { readOnCallRotation, resolveOnCallEmail } from "../db/onCall";
import { excludeDemos } from "../demo";
import { isRingNodeReachingOnCall } from "../ivr/onCallWiring";
import { getUserSettings, normalizeMobileE164 } from "../db/userSettings";
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
  // Carried so checkOnCall can apply the SAME demo exclusion the ring path applies. Its absence
  // here is why the filter was missed on this surface: the write paths were closed and the
  // reporting path silently was not.
  DEMO_ACCOUNT_EMAILS?: string;
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  // The US1-region API key this worker ALREADY holds for `sendSms` (the Messages API is US1-only:
  // "Endpoint is not supported in realm 'au1'"). The two checks that talk to a global Twilio host
  // need exactly the same credential -- see `globalAuth` below.
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
  SERVICEM8_API_KEY?: string;
  TWILIO_INTELLIGENCE_SERVICE_SID?: string;
  TWILIO_PUSH_CREDENTIAL_SID_IOS?: string;
  TWILIO_PUSH_CREDENTIAL_SID_ANDROID?: string;
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
    // On `intelligence_status`, NOT `intelligence_sid`. A recording that came back mono is skipped
    // before Twilio is ever asked, so it has no sid -- and keying on the sid made those rows
    // invisible to the very check whose headline case they are.
    const row = await env.DB.prepare(
      `SELECT
         SUM(intelligence_status = 'completed')      AS done,
         SUM(intelligence_status = 'single_channel') AS mono,
         SUM(intelligence_status = 'pending')        AS pending,
         SUM(intelligence_status IN ('abandoned', 'failed')) AS stuck
       FROM calls
       WHERE intelligence_status IS NOT NULL AND started_at > ?`
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

// Twilio issues credentials PER REGION: "you'll need to use different Auth Tokens and API Keys
// based on which Region you are sending API requests to". This account is AU1-homed, so
// TWILIO_AUTH_TOKEN is the AU1 token -- it has to be, since it authenticates
// api.sydney.au1.twilio.com and validates the webhook signatures on every inbound call. Against
// routes.twilio.com and notify.twilio.com, which are global (implicitly US1), that same token is
// simply not a credential, and the answer is 401 every single time. Push Credentials in particular
// are US1-ONLY by Twilio's own documentation ("REST API operations that manage Push Credentials
// for the Notification service are supported only in US1"), so there is no AU1 host to point at
// even in principle.
//
// That is NOT a reason to give up on checking them, because this worker already holds the other
// credential: `sendSms` uses TWILIO_US1_API_KEY_SID/SECRET for precisely the same reason (the
// Messages API answers "Endpoint is not supported in realm 'au1'"). So both checks send the US1
// key when it is set, and fall back to the AU1 token only when it is not.
//
// Using it is worth more than tidiness. The sandbox flag on the APNs credential is the live lead
// for "the softphone never rang", and a check that permanently answers "can't tell" is the amber
// row nobody reads -- which this file's own rule (`divert_caller_id_last_error` clearing itself,
// the "unfinished" badge that had to stay rare) says is worse than no alarm at all.
type GlobalAuth = { header: string; us1: boolean };

function globalAuth(env: Env): GlobalAuth {
  if (env.TWILIO_US1_API_KEY_SID && env.TWILIO_US1_API_KEY_SECRET) {
    return {
      header: `Basic ${btoa(`${env.TWILIO_US1_API_KEY_SID}:${env.TWILIO_US1_API_KEY_SECRET}`)}`,
      us1: true,
    };
  }
  return { header: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, us1: false };
}

// What a 401 from one of those hosts MEANS depends entirely on which credential we just sent, and
// the two must never be reported as the same thing. With no US1 key there is nothing wrong in the
// console and the remedy is to set the secret -- an actionable next step that clears, rather than
// a permanent warning. With one, a 401 is a real rejection: the auth token exposed on 2026-09-10
// still needs rotating, and a fumbled rotation 401s every Twilio host at once. Explaining THAT
// away as a harmless region quirk would turn this screen into the reassuring silence it exists to
// break.
function regional401(auth: GlobalAuth): string {
  return auth.us1
    ? "Twilio rejected the US1 API key (401) — check TWILIO_US1_API_KEY_SID/SECRET, and whether the auth token rotation took"
    : "this worker holds only the AU1 auth token and that endpoint is US1-only, so it can't be read from here — set TWILIO_US1_API_KEY_SID/SECRET as worker secrets and it can be";
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

  const auth = globalAuth(env);
  const wrong: string[] = [];
  const unknown: string[] = [];
  // Kept as STRUCTURED rows, not pre-formatted prose. The severity below turns on whether the
  // recorded region is au1, and re-deriving that by substring-matching a sentence this function
  // built one line earlier would silently flip a red row to amber the day the wording changes.
  const unverified: { e164: string; region: string | null }[] = [];
  for (const number of numbers) {
    try {
      const res = await withTimeout(
        fetch(`https://routes.twilio.com/v2/PhoneNumbers/${encodeURIComponent(number.e164)}`, {
          headers: { Authorization: auth.header },
        }),
        "Twilio routes"
      );
      // A 404 means no explicit regional config exists, which DEFAULTS to us1 -- the trap itself.
      if (res.status === 404) {
        wrong.push(`${number.e164} (no region set — defaults to us1)`);
        continue;
      }
      if (res.status === 401) {
        // Not transient -- see `globalAuth`. Fall back to the region recorded on /admin/settings,
        // which is the only thing left to go on, flagged as unverified because that column is what
        // someone typed rather than what Twilio believes. `blankToNull`, not `?? null`: an empty
        // string is a value that reads as an answer and would report "recorded as ".
        unverified.push({ e164: number.e164, region: blankToNull(number.region) });
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

  // Every number is accounted for in every branch. These lists used to be first-match-wins, so a
  // number that timed out went unmentioned the moment a DIFFERENT number answered 401 -- and the
  // one it left unmentioned could be the one sitting in us1.
  const leftovers = [
    unverified.length > 0
      ? `Couldn't confirm with Twilio (${regional401(auth)}), so going on what's recorded: ` +
        unverified.map((u) => `${u.e164} (recorded as ${u.region ?? "nothing"})`).join(", ")
      : "",
    unknown.length > 0 ? `Couldn't check at all: ${unknown.join(", ")}` : "",
  ].filter(Boolean);
  const trailing = leftovers.length > 0 ? ` ${leftovers.join(". ")}.` : "";

  if (wrong.length > 0) {
    return {
      ...base,
      status: "fail",
      detail:
        `Not in au1: ${wrong.join(", ")}. Inbound calls to these are handled outside au1, where the softphone can't be connected. ` +
        `Fix on the number's Regional tab in the Twilio console.${trailing}`,
    };
  }
  if (unverified.length > 0) {
    // A region RECORDED as something other than au1 is the dangerous half and earns a fail. A
    // region nobody ever recorded is merely unknown, and unknown is not known-bad: failing on it
    // would turn this row red over a number whose Twilio config may be perfectly correct, and send
    // someone to "fix" a Regional tab that is already right.
    const recordedBad = unverified.filter((u) => u.region !== null && u.region !== "au1");
    return {
      ...base,
      status: recordedBad.length > 0 ? "fail" : "warn",
      detail: `${trailing.trim()} Check the number's Regional tab in the console.`,
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

// The iOS binary that first carries the native CallKit fix for 0xBAADCA11.
//
// Below this, a VoIP push wakes the app in the background and iOS SIGKILLs it after ~5 seconds for
// not reporting the call to CallKit. The symptom is not a crash anyone sees -- it is the softphone
// simply never ringing, then voicemail. The cure is in AppDelegate.swift and can NEVER arrive by
// OTA, so an old binary on the newest OTA is exactly the state that looks fine and is not.
const CALLKIT_FIX_IOS_BUILD = 5;

// A phone nobody has opened in a month is not the phone that failed to ring. Without this bound a
// spare handset left in a drawer -- still installed, still holding a live Expo token, still on
// build 4 -- would pin this check red forever, which is the failure `divert_caller_id_last_error`
// already taught us: an alarm that never clears is an alarm nobody reads.
const DEVICE_ACTIVE_DAYS = 30;
const DEVICE_ACTIVE_MS = DEVICE_ACTIVE_DAYS * 24 * 60 * 60 * 1000;

type DeviceRow = { platform: string; ota_build: string | null; native_build: string | null; last_seen: number };

// A build the handset reports is client-supplied TEXT, so it is not necessarily a number at all --
// a dotted CFBundleVersion ("1.0.4") or any junk parses to NaN, and `NaN < 5` is false. Comparing
// with a bare `Number()` would therefore CLEAR every handset it cannot actually judge, which is the
// precise opposite of this check's own rule that unknown is not the same as fine. So it is parsed
// strictly and anything unreadable falls through to the "has not reported" warn below.
function parseBuildNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Push is per-device, so this reports the caller's OWN registered devices -- the question behind it
// is always "why didn't MY phone buzz".
//
// Note what it therefore CANNOT answer: whether a COLLEAGUE's handset carries the native fix. Their
// phone is the one that did not ring, and it is invisible here. Reading the fleet would need this
// check (and its label) to stop being per-caller.
async function checkPushTokens(env: Env, staff: StaffUser): Promise<Check> {
  const base = { key: "push", label: "Your devices" };
  // Guarded like every other check in this file. `handleGetDiagnostics` runs them under one
  // `Promise.all`, so an unguarded throw here does not fail this row -- it rejects the whole
  // request and the screen that exists to break silence shows nothing at all.
  let rows: DeviceRow[];
  try {
    const res = await env.DB.prepare(
      "SELECT platform, ota_build, native_build, last_seen FROM push_tokens WHERE staff_email = ? ORDER BY last_seen DESC"
    )
      .bind(staff.email)
      .all<DeviceRow>();
    rows = res.results;
  } catch (e) {
    return { ...base, status: "warn", detail: `Couldn't read your registered devices: ${e instanceof Error ? e.message : "error"}` };
  }
  if (rows.length === 0) {
    return { ...base, status: "fail", detail: "No devices registered for push. Open the app on your phone and allow notifications." };
  }

  const describe = (r: DeviceRow) =>
    `${r.platform} ${r.ota_build ? `#${r.ota_build}` : "#?"}${r.native_build ? ` · b${r.native_build}` : ""}`;
  const summary = rows.map(describe).join(", ");

  const active = rows.filter((r) => Date.now() - r.last_seen <= DEVICE_ACTIVE_MS);
  if (active.length === 0) {
    return {
      ...base,
      status: "warn",
      detail:
        `Registered, but no device here has opened the app in ${DEVICE_ACTIVE_DAYS} days, so none of what it last ` +
        `reported is current. Open the app on the phone you answer calls on. (${summary})`,
    };
  }
  const ios = active.filter((r) => r.platform === "ios");

  // An iOS handset on a binary older than the fix is the single most likely reason the softphone
  // did not ring, and it is invisible everywhere else: the OTA number looks current, the device is
  // registered for push, and no crash is ever recorded because no JavaScript runs.
  const stale = ios.filter((r) => {
    const n = parseBuildNumber(r.native_build);
    return n !== null && n < CALLKIT_FIX_IOS_BUILD;
  });
  if (stale.length > 0) {
    const which = stale.map((r) => r.native_build).join(", ");
    return {
      ...base,
      status: "fail",
      detail:
        `${stale.length === 1 ? "An iPhone here is" : `${stale.length} iPhones here are`} on build ${which}, ` +
        `below b${CALLKIT_FIX_IOS_BUILD} — the native fix that stops iOS killing the app before it can ring. ` +
        `Install the latest TestFlight build. (${summary})`,
    };
  }

  // Unknown is NOT the same as fine, and saying so is the whole point: a handset that has not
  // re-registered since build reporting shipped -- or that reported something unreadable -- cannot
  // be cleared, and pretending otherwise is the silence this screen exists to break.
  const unknown = ios.filter((r) => parseBuildNumber(r.native_build) === null);
  if (unknown.length > 0) {
    return {
      ...base,
      status: "warn",
      detail:
        `Registered, but an iPhone here has not reported which build it is running — reopen the app to refresh. ` +
        `Until it does, there is no way to tell whether the native CallKit fix (b${CALLKIT_FIX_IOS_BUILD}) is installed. (${summary})`,
    };
  }

  return { ...base, status: "ok", detail: `${summary}.` };
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

// Is anybody covering tonight? The whole point of the rota is the call that arrives when the office
// is shut, and every way it can fail is silent from the outside: an empty rotation, an anchor that
// was never set, a name that left the business, or an override pointing at a departed tech. In all
// of them the caller simply hears voicemail -- identical to having no rota at all, which is the
// state this feature exists to end. So it is reported here rather than discovered in a month.
async function checkOnCall(env: Env): Promise<Check> {
  const base = { key: "on_call", label: "After-hours on call" };
  try {
    const now = new Date();
    // The wired check is caught SEPARATELY. json_extract raises on a config column that is not
    // valid JSON, and under a shared Promise.all that one bad IVR row would take out the whole
    // on-call check -- so "nobody is on call", "the tech has left" and "no mobile saved" would all
    // stop being reported because of an unrelated node. `null` means "could not verify".
    const [email, wired] = await Promise.all([
      resolveOnCallEmail(env.DB, now),
      isRingNodeReachingOnCall(env.DB).catch((err) => {
        console.log("ON_CALL_WIRING_CHECK_FAILED", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return null;
      }),
    ]);
    if (!email) {
      // "Nobody is set" and "the stored value could not be read" both arrive here as null, and they
      // need different answers: the first is a thing to go and do, the second is a fault. Read the
      // rotation directly to tell them apart rather than sending someone to a Settings screen that
      // already shows a full rota.
      const read = await readOnCallRotation(env.DB);
      if (read.status === "unreadable") {
        return {
          ...base,
          status: "fail",
          detail: "A rotation is saved but its stored value cannot be read — after-hours callers go straight to voicemail. Re-save it in Settings.",
        };
      }
      if (read.rotation.members.length > 0) {
        return {
          ...base,
          status: "fail",
          detail: "A rotation is saved but no week could be resolved from it. Re-save it in Settings.",
        };
      }
      return {
        ...base,
        status: "warn",
        detail:
          wired === false
            ? "Nobody is on call this week, and no step of the phone menu rings the on-call person — after-hours callers go straight to voicemail. Both need doing: set the rotation in Settings, and add a ring step set to \"Whoever is on call\" on the closed branch of the phone menu."
            : "Nobody is on call this week — after-hours callers go straight to voicemail. Set the rotation in Settings.",
      };
    }
    // The SAME exclusion resolveRingTargets applies at dial time. Without it this reported
    // "reviewer is on call, ringing +61..." over a rotation that rings nobody.
    const roster = excludeDemos(await getStaffRoster(env.DB), env);
    const person = roster.find((s) => s.email.toLowerCase() === email.toLowerCase());
    if (!person) {
      return {
        ...base,
        status: "fail",
        detail: `${email} is on call this week but is no longer a staff member. After-hours calls go to voicemail.`,
      };
    }
    // A rotation entry with no mobile still rings, but only via the softphone -- the one leg that
    // depends on a backgrounded app waking up, at the hour when nobody is watching it.
    const prefs = await getUserSettings(env.DB, person.email);
    const mobile = normalizeMobileE164(prefs.mobile_number);
    const who = person.email.split("@")[0];
    // Reported FIRST, because it is the more severe answer and it subsumes the other: with the
    // menu unwired the call reaches neither their mobile nor their app, so "no mobile saved, the
    // call can only reach their app" would be actively misleading. Adding a mobile and re-running
    // is not how anyone should discover the whole feature is inert.
    if (wired === false) {
      return {
        ...base,
        status: "fail",
        detail: `${who} is on call this week, but no step of the phone menu rings the on-call person — after-hours callers still reach voicemail. Add a ring step set to "Whoever is on call" on the closed branch.`,
      };
    }
    if (!mobile) {
      return {
        ...base,
        status: "warn",
        detail: `${who} is on call this week but has no mobile number saved, so the call can only reach their app. Add one on their staff record.`,
      };
    }
    if (wired === null) {
      return { ...base, status: "warn", detail: `${who} is on call this week, ringing ${mobile} — but the phone menu could not be read to confirm a step routes to them.` };
    }
    return { ...base, status: "ok", detail: `${who} is on call this week, ringing ${mobile}.` };
  } catch (e) {
    return { ...base, status: "warn", detail: `Couldn't check: ${e instanceof Error ? e.message : "error"}` };
  }
}

// Can Twilio wake a sleeping handset at all?
//
// This is the check that was missing on 2026-09-11, when a call rang the softphone for the full
// 22 and 62 seconds and the phone never stirred. `mintAccessToken` sets `push_credential_sid` only
// `if (opts.pushCredentialSid)` -- so an unset secret mints a perfectly valid token with no push
// credential on it, the app registers happily, and Twilio then has no way to send it a VoIP push.
// The softphone simply never rings. No error, no log line, no crash: the same silence that hid
// SERVICEM8_API_KEY for a day, on the one path where the cost is a missed customer.
//
// `deploy.yml` does not set it -- wrangler secrets are separate -- and only the ANDROID sid is in
// wrangler.jsonc, so iOS has always depended on a secret nothing verified.
//
// It also reads `sandbox`, which the phase-1 softphone design named as a risk in its own words:
// "APNs environment mismatch (sandbox vs production push credential) is a common cause of 'no
// incoming ring'". A TestFlight or App Store build talks to PRODUCTION APNs, so a sandbox
// credential is silence -- and it looks identical to everything working.
async function checkVoipPushCredentials(env: Env): Promise<Check> {
  const base = { key: "voip_push", label: "Ringing the app" };
  const configured = [
    { platform: "iPhone", sid: env.TWILIO_PUSH_CREDENTIAL_SID_IOS, expect: "apn" as const },
    { platform: "Android", sid: env.TWILIO_PUSH_CREDENTIAL_SID_ANDROID, expect: "fcm" as const },
  ];

  const missing = configured.filter((c) => !c.sid);
  if (missing.length === configured.length) {
    return {
      ...base,
      status: "fail",
      detail:
        "No VoIP push credential is set, so Twilio cannot wake the app for an incoming call — " +
        "the softphone will never ring. Set TWILIO_PUSH_CREDENTIAL_SID_IOS as a worker secret.",
    };
  }

  const notes: string[] = [];
  let worst: CheckStatus = "ok";
  const bump = (s: CheckStatus) => {
    if (s === "fail" || (s === "warn" && worst === "ok")) worst = s;
  };

  const auth = globalAuth(env);
  // Tracked as a flag on the APNs entry, not re-read out of the notes afterwards. The guidance it
  // gates is specifically "go and look at the APNs credential", so it has to mean "the APNs one is
  // the credential we could not read" -- pointing someone at APNs because the FCM credential 401'd
  // would send them to re-check the very credential this run just verified as production.
  let apnsUnreadable = false;

  for (const c of configured) {
    if (!c.sid) {
      notes.push(`${c.platform}: not set — the softphone will never ring on it`);
      bump("fail");
      continue;
    }
    try {
      const res = await fetch(`https://notify.twilio.com/v1/Credentials/${encodeURIComponent(c.sid)}`, {
        headers: { Authorization: auth.header },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (res.status === 404) {
        // NOT "it does not exist", however much it looks like it. Push credentials are
        // REGION-SCOPED resources, and this lookup is US1 (notify.twilio.com is global, and
        // Twilio's console for managing them "is available only in US1") while this account is
        // AU1. A credential living in au1 is invisible here and answers 404 identically to one
        // that was never created.
        //
        // Proven the hard way on 2026-09-11: this check reported BOTH credentials as not existing
        // while the Android handset was ringing perfectly well on one of them. A red row telling
        // someone to recreate a working credential is far worse than no row -- it invites them to
        // break the half that still works, on the day they are already missing calls.
        //
        // So: warn, say plainly that it could not be confirmed, and defer to the better evidence.
        // A handset that rings IS the credential working, and no API lookup beats that.
        notes.push(
          `${c.platform}: couldn't confirm — push credentials are region-scoped and this lookup is US1, but the account is AU1`
        );
        bump("warn");
        continue;
      }
      if (res.status === 401) {
        // Not a blip -- see `globalAuth`, and `regional401` for why "no US1 key" and "the US1 key
        // was rejected" must read differently. Either way the credential is SET (we have a sid);
        // what cannot be read is whether it is sandbox or production, which is the half that
        // matters. Say exactly that, and where to look.
        notes.push(`${c.platform}: set, but not verifiable here — ${regional401(auth)}`);
        if (c.expect === "apn") apnsUnreadable = true;
        bump("warn");
        continue;
      }
      if (!res.ok) {
        notes.push(`${c.platform}: couldn't check (Twilio answered ${res.status})`);
        bump("warn");
        continue;
      }
      const cred = (await res.json()) as { type?: string; sandbox?: string | boolean; friendly_name?: string };
      // A string "true" is what the API returns; accept the boolean too rather than trusting one.
      const sandbox = cred.sandbox === true || cred.sandbox === "true";
      if (cred.type !== c.expect) {
        notes.push(`${c.platform}: credential is type '${cred.type ?? "?"}', expected '${c.expect}'`);
        bump("fail");
        continue;
      }
      if (sandbox) {
        notes.push(
          `${c.platform}: credential is SANDBOX — a TestFlight or App Store build talks to production APNs, so it will never ring`
        );
        bump("fail");
        continue;
      }
      notes.push(`${c.platform}: ${cred.type}${cred.type === "apn" ? ", production" : ""}`);
    } catch {
      notes.push(`${c.platform}: couldn't reach Twilio to check`);
      bump("warn");
    }
  }

  const detail = notes.join(". ") + ".";
  // When the APNs credential is the one we could not read, say what to do rather than leaving an
  // amber row with no next step -- a sandbox APNs credential is silence on a TestFlight build and
  // looks identical to everything working, so that is the one to check by hand. iOS unreadable
  // while Android answers fine is the normal case here: FCM and APNs are separate credentials and
  // only one of them decides whether a TestFlight build rings.
  return {
    ...base,
    status: worst,
    detail: apnsUnreadable
      ? `${detail} Open Twilio Console > Voice > Push Credentials (US1 region) and confirm the APNs one is NOT sandbox.`
      : detail,
  };
}

export async function handleGetDiagnostics(env: Env, staff: StaffUser): Promise<Response> {
  // The names below are POSITIONAL: each binding takes whatever the call in the same position
  // returns. Keep the two lists in the same order and the same length -- adding a call without a
  // binding silently shifts every one after it and drops the last check off the end entirely, which
  // is exactly what happened when the transcripts check was first added here.
  const [twilio, regions, roster, onCall, divert, servicem8, transcripts, voipPush, push] = await Promise.all([
    checkTwilioCredentials(env),
    checkNumberRegions(env),
    checkRingRoster(env),
    checkOnCall(env),
    checkDivertCallerId(env),
    checkServiceM8(env),
    checkCallTranscripts(env),
    checkVoipPushCredentials(env),
    checkPushTokens(env, staff),
  ]);
  // Display order, which is deliberately not the call order.
  return jsonResponse([twilio, regions, roster, onCall, divert, servicem8, transcripts, checkEmail(env), voipPush, push]);
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

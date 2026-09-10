import { getStaffRoster } from "../db/staff";
import { isStaffAvailable, isOnShift } from "./presence";
import { getUserSettings, normalizeMobileE164 } from "../db/userSettings";
import { resolveOnCallEmail } from "../db/onCall";

// "on_call" resolves to the single person the weekly after-hours rotation names, which is a
// deliberately DIFFERENT question from "who is on shift" -- see resolveRingTargets below.
export type RingNodeTarget = "all" | "on_call" | string[];

// Resolves the ordered list of legs to ring for a ring node, in ascending ring-priority order.
//
// Each on-shift staff member contributes exactly ONE leg. Ring-my-mobile is a DIVERT, not an
// "also ring": when it is on and the number is dialable, the call goes to their personal mobile
// (`pstn:{email}|{e164}`) and their softphone is deliberately NOT rung. Otherwise they get their
// softphone leg (`client:{email}`), provided a fresh heartbeat proves the app is online.
//
// An unusable mobile number falls back to the softphone rather than dropping the person silently,
// so a typo can never route a caller straight to voicemail. The mobile leg ignores the softphone
// heartbeat by design (isOnShift, not isStaffAvailable) — the whole point is to reach their cell
// when the app is closed.
//
// One leg per person is also what keeps `ring_priority` meaningful: returning the legs grouped by
// type would reorder people, which cascade (dials numbers[0] first) turns into the wrong person
// ringing first.
// `excludeEmails` keeps the App Review demo account out of the roster. Signing in flips a staff
// row to `available`, and the simultaneous ring strategy rings everyone available at once --
// `ring_priority` protects nobody there -- so without this an Apple reviewer would become a live
// destination and could answer a real customer's call.
export async function resolveRingTargets(
  db: D1Database,
  target: RingNodeTarget,
  now: Date,
  excludeEmails: string[] = []
): Promise<string[]> {
  const excluded = new Set(excludeEmails.map((e) => e.trim().toLowerCase()));
  // The ROSTER read needs the same guard as the per-person read below, and for the same reason: a
  // throw here escapes startRing to the DO catch-all and hangs up on a live customer. Guarding only
  // the inner read left the outer one -- a single D1 blip away from the exact failure this exists to
  // prevent. An empty roster is the fall-through the ring node already handles: zero legs continues
  // the flow from noAnswerNextNodeId, i.e. voicemail, which is what every other dial failure does.
  let all: Awaited<ReturnType<typeof getStaffRoster>>;
  try {
    all = await getStaffRoster(db);
  } catch (err) {
    console.log(
      "RING_ROSTER_LOOKUP_FAILED",
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    );
    return [];
  }
  const roster = all.filter((s) => !excluded.has(s.email.toLowerCase()));

  // The on-call branch answers a different question from every other target, and deliberately
  // bypasses BOTH gates that the others apply.
  //
  // The working-hours schedule is bypassed because that is the entire point: after hours nobody's
  // schedule is open, which is precisely why the closed branch of the IVR could only ever reach
  // voicemail. Gating on-call by the same schedule would resolve to nobody, every time, forever.
  //
  // `status` is bypassed for a less obvious reason. `away`/`offline` is a live "don't ring me"
  // signal meant for the working day, and it is sticky -- someone who set Away at 4pm and went home
  // still carries it at 11pm. Honouring it here means one forgotten toggle silently disables the
  // entire after-hours rota, with the caller hearing voicemail and nothing anywhere saying why.
  // Being on call IS the commitment to be rung, so the rota wins; the way out is to swap the week,
  // which the override exists for.
  if (target === "on_call") {
    const email = await resolveOnCallEmail(db, now);
    if (!email) return [];
    const person = roster.find((s) => s.email.toLowerCase() === email.toLowerCase());
    // Named but no longer on the roster -- removed, or excluded as a demo account. Falls through to
    // voicemail rather than dialling a stranger, and Health Checks reports the dangling name.
    if (!person) {
      console.log("ON_CALL_NOT_ON_ROSTER", JSON.stringify({ email }));
      return [];
    }
    return [await onCallLeg(db, person)];
  }

  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  const onShift = candidates.filter((s) => isOnShift(s, now));
  onShift.sort((a, b) => a.ringPriority - b.ringPriority || a.email.localeCompare(b.email));

  const legs: string[] = [];
  for (const s of onShift) {
    // This read must NEVER throw. It is called from startRing, and tier 1 established what a throw
    // there costs: it escapes handleMainWebhook to the DO's catch-all, which answers "we're
    // experiencing a technical issue" and HANGS UP on a live customer -- and via performDeferredDial
    // does that to someone already waiting on hold. `callerId()` was fixed for exactly this; this
    // read sits one line away at CallSession.ts:402 and was missed.
    //
    // The fallback is the softphone leg, which is simply what this person gets when ring-my-mobile
    // is off. A caller reaching a handset that might not be the preferred one is strictly better
    // than a caller being hung up on, and better than every OTHER person's leg disappearing too.
    let prefs: Awaited<ReturnType<typeof getUserSettings>> | null = null;
    try {
      prefs = await getUserSettings(db, s.email);
    } catch (err) {
      console.log(
        "RING_PREFS_LOOKUP_FAILED",
        JSON.stringify({ email: s.email, error: err instanceof Error ? err.message : String(err) })
      );
    }
    const e164 = prefs?.ring_my_mobile ? normalizeMobileE164(prefs.mobile_number) : null;
    if (e164) legs.push(`pstn:${s.email}|${e164}`);
    else if (isStaffAvailable(s, now)) legs.push(`client:${s.email}`);
  }
  return legs;
}

// The on-call leg prefers the personal MOBILE regardless of that person's ring-my-mobile toggle,
// which is the one place this system overrides a staff preference.
//
// Ring-my-mobile is a daytime convenience: with it off, the call rings the softphone, which depends
// on a backgrounded app being woken by a VoIP push. That is a reasonable bet at 10am with the phone
// in your hand. At 2am it is the weakest link in the chain -- it is exactly the path that iOS's
// CallKit watchdog was killing on 2026-09-10 -- and the whole value of an on-call rota is that the
// one call it exists for is not the one that gets missed. The carrier network needs no app to be
// alive.
//
// No mobile saved falls back to the softphone rather than returning nothing: a person on call with
// a reachable app beats a caller sent to voicemail.
async function onCallLeg(db: D1Database, person: { email: string }): Promise<string> {
  let prefs: Awaited<ReturnType<typeof getUserSettings>> | null = null;
  try {
    prefs = await getUserSettings(db, person.email);
  } catch (err) {
    console.log(
      "ON_CALL_PREFS_LOOKUP_FAILED",
      JSON.stringify({ email: person.email, error: err instanceof Error ? err.message : String(err) })
    );
  }
  const e164 = prefs ? normalizeMobileE164(prefs.mobile_number) : null;
  return e164 ? `pstn:${person.email}|${e164}` : `client:${person.email}`;
}

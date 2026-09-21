// Which IVR flow does a call to THIS number enter?
//
// Until migration 0041 the answer was hardcoded in CallSession: "main" in hours, "after_hours"
// outside them, for every number the business holds. `phone_numbers` now carries a per-number
// override for each, so a second line can have a menu of its own.
//
// TWO THINGS ABOUT THIS MODULE ARE LOAD-BEARING.
//
// 1. **It must never throw.** It is read inside `handleMainWebhook`, and a throw there escapes to
//    the Durable Object's catch-all, which says "we're experiencing a technical issue" and HANGS UP
//    ON A LIVE CUSTOMER. Same family as `callerId()`, `resolveRingTargets` and `playFromConfig` --
//    see the "THREE reads on the ring path must never throw" note in CLAUDE.md. A failed read here
//    falls back to the defaults, which is the behaviour every call had before this feature existed.
//
// 2. **It is ONE read, not two.** It replaces the older `isVoiceDisabled` lookup rather than sitting
//    beside it: both want the same row, and a live caller should not wait on two round trips to D1
//    to find out which greeting to play.

import { flowHasEntryNode } from "../db/ivrNodes";

// The flows every number falls back to. These are the names CallSession hardcoded before 0041, so
// a number with no override -- or no `phone_numbers` row at all -- routes exactly as it used to.
export const DEFAULT_FLOW = "main";
export const DEFAULT_AFTER_HOURS_FLOW = "after_hours";

export type NumberRouting = {
  // True ONLY when this number is one of ours AND is explicitly marked as not taking voice.
  voiceDisabled: boolean;
  inHoursFlow: string;
  afterHoursFlow: string;
};

export const DEFAULT_ROUTING: NumberRouting = {
  voiceDisabled: false,
  inHoursFlow: DEFAULT_FLOW,
  afterHoursFlow: DEFAULT_AFTER_HOURS_FLOW,
};

type Row = {
  voice_enabled: number;
  ivr_flow: string | null;
  after_hours_flow: string | null;
};

// A stored flow name is trimmed and blank-checked here rather than trusted: `""` is not NULL, and
// `?? DEFAULT` would let an empty string through to `loadEntryNode`, which then throws on a flow
// that cannot exist. Same shape as the `audioAssetId` blank-vs-null trap in flowEngine.
function flowOr(stored: string | null, fallback: string): string {
  const trimmed = (stored ?? "").trim();
  return trimmed === "" ? fallback : trimmed;
}

export async function resolveNumberRouting(db: D1Database, e164: string): Promise<NumberRouting> {
  try {
    const row = await db
      .prepare("SELECT voice_enabled, ivr_flow, after_hours_flow FROM phone_numbers WHERE e164 = ?")
      .bind(e164)
      .first<Row>();
    // No row: a Twilio number nobody recorded on /admin/settings. Fail OPEN -- refusing a real
    // customer because of a missing admin row is far worse than the mismatch the voice switch guards.
    if (!row) return DEFAULT_ROUTING;
    return {
      voiceDisabled: !row.voice_enabled,
      inHoursFlow: flowOr(row.ivr_flow, DEFAULT_FLOW),
      afterHoursFlow: flowOr(row.after_hours_flow, DEFAULT_AFTER_HOURS_FLOW),
    };
  } catch (err) {
    console.log(
      "NUMBER_ROUTING_LOOKUP_FAILED",
      JSON.stringify({ e164, error: err instanceof Error ? err.message : String(err) })
    );
    return DEFAULT_ROUTING;
  }
}

// The flows to try, in order, for one inbound call. The FIRST is what the admin configured; the
// rest exist so a broken or deleted flow degrades to a working menu instead of hanging up.
//
// In hours:      [number's flow, "main"]
// After hours:   [number's after-hours flow, "after_hours", "main"]
//
// Each rung is MORE GENERIC FOR THE SAME SITUATION. The number's own in-hours flow is deliberately
// NOT a rung of the after-hours chain: it is a sideways move, not a more generic one, and it would
// play a 2am caller the daytime menu of that line where pre-0041 code fell through to `main`'s
// closed branch. Found by `/code-review` before this shipped.
//
// With no per-number overrides this is exactly the pre-0041 behaviour: in hours ["main"], after
// hours ["after_hours", "main"] -- the same single try, and the same one after-hours fallback.
// Only a broken `main` hangs up, which is what happened before and is the one case with nothing
// left to fall back to.
export function entryFlowCandidates(routing: NumberRouting, isAfterHours: boolean): string[] {
  const ordered = isAfterHours
    ? [routing.afterHoursFlow, DEFAULT_AFTER_HOURS_FLOW, DEFAULT_FLOW]
    : [routing.inHoursFlow, DEFAULT_FLOW];
  return [...new Set(ordered)];
}

// Every voice-enabled number, with the route it resolves to. Used by the checks that ask "is this
// reachable on a real call?" -- they must look at the flows numbers actually point at, not at the
// two names that used to be the only answer.
//
// A business with NO voice-enabled rows still takes calls (the resolver falls open to the defaults
// for an unknown number), so one synthetic default entry stands in for that case rather than
// returning an empty list a caller would read as "nothing to check".
// `configured` is the RAW stored value, null where the number has no route of its own. A check must
// be able to tell "the admin set this and it is broken" from "the shared default happens to be
// unusable, and the fallback chain handles that" -- reporting the second as a hard failure would
// pin Health Checks red over a working system, which is the self-clearing-marker lesson from
// `divert_caller_id_last_error`.
export type NumberRoute = {
  e164: string | null;
  label: string;
  routing: NumberRouting;
  configured: { inHours: string | null; afterHours: string | null };
};

export async function routesInUse(db: D1Database): Promise<NumberRoute[]> {
  const rows = await db
    .prepare(
      "SELECT e164, label, ivr_flow, after_hours_flow FROM phone_numbers WHERE voice_enabled = 1 ORDER BY id ASC"
    )
    .all<{ e164: string; label: string; ivr_flow: string | null; after_hours_flow: string | null }>();
  if (rows.results.length === 0) {
    return [
      {
        e164: null,
        label: "Any number not listed in Settings",
        routing: DEFAULT_ROUTING,
        configured: { inHours: null, afterHours: null },
      },
    ];
  }
  return rows.results.map((row) => {
    // A blank stored value is no override, so it is not "configured" either -- otherwise a row
    // holding "" would be reported as an admin choice that cannot work.
    const inHours = flowOr(row.ivr_flow, DEFAULT_FLOW);
    const afterHours = flowOr(row.after_hours_flow, DEFAULT_AFTER_HOURS_FLOW);
    return {
      e164: row.e164,
      label: row.label,
      routing: { voiceDisabled: false, inHoursFlow: inHours, afterHoursFlow: afterHours },
      configured: {
        inHours: inHours === DEFAULT_FLOW && !row.ivr_flow?.trim() ? null : inHours,
        afterHours: afterHours === DEFAULT_AFTER_HOURS_FLOW && !row.after_hours_flow?.trim() ? null : afterHours,
      },
    };
  });
}

// Re-exported so callers validating a route don't have to reach into the nodes module directly.
export { flowHasEntryNode };

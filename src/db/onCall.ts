import {
  isOnCallRotation,
  rotationMemberFor,
  weekStartKey,
  type OnCallRotation,
} from "../dial/onCall";

const ON_CALL_ROTATION_KEY = "on_call_rotation";

// A FRESH object on every miss, never a shared module-level constant. getOnCallRotation returns
// this from three separate paths and handleGetOnCall serialises it, so one caller mutating what it
// got back would corrupt the "nobody on call" default for every later read in the isolate.
const emptyRotation = (): OnCallRotation => ({ members: [], anchorWeekStart: "" });

export async function getOnCallRotation(db: D1Database): Promise<OnCallRotation> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(ON_CALL_ROTATION_KEY).first<{ value: string }>();
  if (!row) return emptyRotation();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Same rule as every other stored-JSON read on the call path: an unreadable value is "nobody is
    // on call", never a throw. The Health Check is what makes that state visible.
    console.log("ON_CALL_ROTATION_UNPARSEABLE", JSON.stringify({ value: row.value.slice(0, 120) }));
    return emptyRotation();
  }
  if (!isOnCallRotation(parsed)) {
    console.log("ON_CALL_ROTATION_UNPARSEABLE", JSON.stringify({ error: "not a rotation shape" }));
    return emptyRotation();
  }
  return parsed;
}

export async function setOnCallRotation(db: D1Database, rotation: OnCallRotation): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(ON_CALL_ROTATION_KEY, JSON.stringify(rotation))
    .run();
}

export async function getOnCallOverride(db: D1Database, weekStart: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT staff_email FROM on_call_overrides WHERE week_start = ?")
    .bind(weekStart)
    .first<{ staff_email: string }>();
  return row?.staff_email ?? null;
}

export async function listOnCallOverrides(db: D1Database, fromWeekStart: string): Promise<{ week_start: string; staff_email: string }[]> {
  const rows = await db
    .prepare("SELECT week_start, staff_email FROM on_call_overrides WHERE week_start >= ? ORDER BY week_start")
    .bind(fromWeekStart)
    .all<{ week_start: string; staff_email: string }>();
  return rows.results;
}

export async function setOnCallOverride(db: D1Database, weekStart: string, email: string, by: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO on_call_overrides (week_start, staff_email, created_at, created_by) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(week_start) DO UPDATE SET staff_email = excluded.staff_email, created_at = excluded.created_at, created_by = excluded.created_by"
    )
    .bind(weekStart, email, Date.now(), by)
    .run();
}

export async function clearOnCallOverride(db: D1Database, weekStart: string): Promise<void> {
  await db.prepare("DELETE FROM on_call_overrides WHERE week_start = ?").bind(weekStart).run();
}

// Who is on call at `at`: the week's override if one exists, otherwise whose turn the rotation says
// it is. Returns null for "nobody", which the ring node already handles by falling through to its
// noAnswerNextNodeId (i.e. voicemail) -- the exact behaviour after hours had before this existed.
//
// This is called from startRing and therefore MUST NOT THROW. The cost of a throw there is not a
// missed feature: it escapes handleMainWebhook to the DO's catch-all, which says "we're
// experiencing a technical issue" and hangs up on a live customer. Every failure is swallowed and
// logged, and every failure resolves to "nobody on call", which degrades to the pre-existing
// after-hours voicemail rather than to a dropped call.
export async function resolveOnCallEmail(db: D1Database, at: Date): Promise<string | null> {
  let weekStart: string;
  try {
    weekStart = weekStartKey(at);
  } catch (err) {
    console.log("ON_CALL_LOOKUP_FAILED", JSON.stringify({ stage: "week", error: err instanceof Error ? err.message : String(err) }));
    return null;
  }

  // The two reads are guarded SEPARATELY and run in parallel, which matters on both counts.
  //
  // Separately, because overrides are normally empty -- a swap is rare -- and under one shared
  // catch a transient failure reading that table threw away a perfectly good rotation and dropped
  // the rota entirely. The 2am caller then reached voicemail while `settings.on_call_rotation` sat
  // intact in D1 naming a reachable tech. A failed override read now degrades to "no swap this
  // week", which is the state it holds 51 weeks a year anyway.
  //
  // In parallel, because this sits on the ring path with a customer already listening: two serial
  // D1 round trips in front of them is the same avoidable wait that moved the caller-ID lookup out
  // of the per-leg loop.
  const [override, rotation] = await Promise.all([
    getOnCallOverride(db, weekStart).catch((err) => {
      console.log("ON_CALL_OVERRIDE_LOOKUP_FAILED", JSON.stringify({ weekStart, error: err instanceof Error ? err.message : String(err) }));
      return null;
    }),
    getOnCallRotation(db).catch((err) => {
      console.log("ON_CALL_LOOKUP_FAILED", JSON.stringify({ stage: "rotation", error: err instanceof Error ? err.message : String(err) }));
      return null;
    }),
  ]);

  if (override) return override;
  if (!rotation) return null;
  return rotationMemberFor(rotation, weekStart);
}

import { jsonResponse } from "./respond";
import { getCallDetail, listCalls, listLiveCalls, updateCallMeta } from "../db/calls";
import { normalizeCallStatus } from "../twilio/statusCallback";
import { authHeader } from "../twilio/conferenceClient";

export async function handleListCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listCalls(db));
}

export async function handleUpdateCallMeta(request: Request, db: D1Database, callId: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { disposition?: unknown; notes?: unknown } | null;
  if (!body) return jsonResponse({ error: "invalid request body" }, 400);
  const disposition = typeof body.disposition === "string" ? body.disposition.slice(0, 100) : null;
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 4000) : null;
  const ok = await updateCallMeta(db, callId, { disposition: disposition || null, notes: notes || null });
  return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: "not found" }, 404);
}

type LiveEnv = { DB: D1Database; TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string };

const AU1_BASE = "https://api.sydney.au1.twilio.com/2010-04-01/Accounts";

// The set of Call SIDs Twilio currently reports as in-progress (AU1), or null if the lookup failed.
// Shared by getLiveCalls (fail-open on null) and reconcileStaleCalls (fail-safe on null). PageSize
// 100 is far above any realistic concurrent-leg count for this account; add paging if ever exceeded.
async function fetchInProgressCallSids(env: LiveEnv): Promise<Set<string | undefined> | null> {
  try {
    const r = await fetch(`${AU1_BASE}/${env.TWILIO_ACCOUNT_SID}/Calls.json?Status=in-progress&PageSize=100`, {
      headers: { Authorization: authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { calls?: { sid?: string }[] };
    return new Set((j.calls ?? []).map((c) => c.sid));
  } catch {
    return null;
  }
}

// Genuinely-live calls: the D1 in_progress rows (last 3h) verified against Twilio — a row only
// survives if Twilio reports that call SID as in-progress RIGHT NOW. This drops rows whose
// "completed" status callback was ever missed (which otherwise linger as fake live calls). Our
// calls.id is the caller's inbound leg (or the browser leg for outbound), which Twilio lists as
// in-progress while the call/conference is active. If the Twilio lookup fails, fall back to the raw
// D1 rows rather than hiding everything. Used by both the /admin/live page and /api/calls/live.
export async function getLiveCalls(env: LiveEnv) {
  const rows = await listLiveCalls(env.DB);
  if (rows.length === 0) return rows;
  const liveSids = await fetchInProgressCallSids(env);
  if (!liveSids) return rows; // fail-open: show unverified rows rather than hiding everything
  return rows.filter((row) => liveSids.has(row.id));
}

export async function handleLiveCalls(env: LiveEnv): Promise<Response> {
  return jsonResponse(await getLiveCalls(env));
}

// SOURCE FIX for missed status callbacks: a call is marked completed by /webhooks/twilio/status when
// Twilio fires it — but that callback can be dropped (or not configured), leaving the row stuck as
// `in_progress` forever. This sweep (run on a cron) reconciles any in_progress row older than 2min
// against Twilio: rows Twilio no longer reports as in-progress get their REAL terminal status +
// end-time written from Twilio. Safe: aborts if the bulk lookup fails, and per-call it only closes
// rows whose Twilio status is actually terminal (or a 404 = call Twilio no longer knows about).
export async function reconcileStaleCalls(env: LiveEnv): Promise<number> {
  const cutoff = Date.now() - 2 * 60 * 1000;
  const rows = (
    await env.DB.prepare("SELECT id FROM calls WHERE status = 'in_progress' AND ended_at IS NULL AND started_at < ?")
      .bind(cutoff)
      .all<{ id: string }>()
  ).results;
  if (rows.length === 0) return 0;

  const liveSids = await fetchInProgressCallSids(env);
  if (!liveSids) return 0; // fail-safe: don't reconcile if we can't confirm liveness right now

  const auth = authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const base = `${AU1_BASE}/${env.TWILIO_ACCOUNT_SID}`;

  // Each stale row is independent (one Twilio GET + one guarded D1 UPDATE), so reconcile them
  // concurrently — a serial loop made ~20 stuck rows cost ~20 sequential round-trips.
  const results = await Promise.all(
    rows.map(async (row): Promise<number> => {
      if (liveSids.has(row.id)) return 0; // still genuinely live
      let status = "completed";
      let endedAt = Date.now();
      try {
        const cr = await fetch(`${base}/Calls/${row.id}.json`, { headers: { Authorization: auth } });
        if (cr.ok) {
          const c = (await cr.json()) as { status?: string; end_time?: string };
          const norm = normalizeCallStatus(c.status ?? "");
          if (!norm) return 0; // Twilio still says non-terminal (ringing/queued) — leave it
          status = norm;
          if (c.end_time) {
            const parsed = Date.parse(c.end_time);
            if (!Number.isNaN(parsed)) endedAt = parsed;
          }
        } else if (cr.status !== 404) {
          return 0; // transient error — try again next sweep
        }
        // 404 falls through with status "completed" (Twilio no longer knows this call).
      } catch {
        return 0;
      }
      const upd = await env.DB.prepare("UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL")
        .bind(status, endedAt, row.id)
        .run();
      return (upd.meta.changes ?? 0) > 0 ? 1 : 0;
    })
  );
  return results.reduce((a, b) => a + b, 0);
}

export async function handleCallDetail(db: D1Database, callId: string): Promise<Response> {
  const detail = await getCallDetail(db, callId);
  if (!detail) return new Response("not found", { status: 404 });
  return jsonResponse(detail);
}

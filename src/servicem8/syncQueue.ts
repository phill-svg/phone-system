import { logCallAndSyncContact, type LoggableCall } from "./callLogging";

// How long after a call ends before ServiceM8 is asked about the caller.
//
// This wait is the whole point of the queue. Staff routinely create the ServiceM8 client or job
// DURING the call or right after hanging up, so looking the number up the instant the call ended
// searched for a record that did not exist yet: no note, no contact, and no second attempt.
//
// FIFTEEN minutes, raised from three on 2026-09-11 at Phill's request, with a real case behind it.
// A call from a new customer ended at 13:03:18; the sweep looked at 13:06:50 and found nothing;
// Job #985 was created at 13:09:33 -- two and a half minutes after the only look this call would
// ever get. No diary note, no contact, and nothing anywhere saying so. Three minutes assumed the
// record is typed in while the call is still fresh; in practice the job gets written up after the
// customer has been dealt with, which is most of ten minutes later.
//
// The cost of raising it is real and worth stating: the caller's NAME does not appear in the app
// until the sweep runs, so for fifteen minutes a new customer shows as a bare number in Recents
// and in the message thread. That is the trade -- a name that arrives late beats one that never
// arrives at all.
//
// This does NOT make the lookup retry. A `no-match` is still claimed permanently (only `failed`
// releases the claim), so a job created at minute sixteen is lost exactly as before. Fifteen
// minutes moves the line; it does not remove it.
export const SERVICEM8_SYNC_DELAY_MS = 15 * 60 * 1000;

// How far back the sweep will reach. Without this, the first tick after deploying would treat every
// historical call as pending and post notes on jobs for calls from weeks ago. It also bounds
// retries: a call that keeps failing simply ages out instead of being retried forever.
export const SERVICEM8_SYNC_WINDOW_MS = 2 * 60 * 60 * 1000;

// Calls handled per tick. The sweep runs every minute, so this is throughput of 5/min -- well
// above TCB's call volume, and it keeps one busy hour from hammering ServiceM8 in a single burst.
const BATCH = 5;

type PendingCall = {
  id: string;
  direction: "inbound" | "outbound";
  caller_number: string;
  called_number: string;
  started_at: number;
  ended_at: number;
  status: string;
};

type Env = { DB: D1Database; SERVICEM8_API_KEY?: string };

// Cron sweep: every call that ended at least SERVICEM8_SYNC_DELAY_MS ago and hasn't had its
// ServiceM8 work done yet.
export async function syncPendingCallsToServiceM8(env: Env): Promise<void> {
  const now = Date.now();
  const pending = await env.DB.prepare(
    "SELECT id, direction, caller_number, called_number, started_at, ended_at, status FROM calls " +
      "WHERE ended_at IS NOT NULL AND servicem8_synced_at IS NULL AND deleted_at IS NULL AND ended_at <= ? AND ended_at >= ? " +
      "ORDER BY ended_at ASC LIMIT ?"
  )
    .bind(now - SERVICEM8_SYNC_DELAY_MS, now - SERVICEM8_SYNC_WINDOW_MS, BATCH)
    .all<PendingCall>();

  if (pending.results.length === 0) return;

  if (!env.SERVICEM8_API_KEY) {
    // Say it once per tick rather than once per call. `deploy.yml` does not set this -- it is a
    // wrangler secret: npx wrangler secret put SERVICEM8_API_KEY
    console.log("SERVICEM8_DISABLED", JSON.stringify({ pending: pending.results.length }));
    return;
  }

  for (const call of pending.results) {
    // Claim the row BEFORE doing any work. Two overlapping ticks would otherwise both pick up the
    // same call and post the diary note twice, which staff would see in ServiceM8.
    const claim = await env.DB.prepare(
      "UPDATE calls SET servicem8_synced_at = ? WHERE id = ? AND servicem8_synced_at IS NULL"
    )
      .bind(now, call.id)
      .run();
    if ((claim.meta.changes ?? 0) === 0) continue; // another tick got there first

    const loggable: LoggableCall = {
      direction: call.direction,
      callerNumber: call.caller_number,
      calledNumber: call.called_number,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      status: call.status,
    };

    let outcome: Awaited<ReturnType<typeof logCallAndSyncContact>>;
    try {
      outcome = await logCallAndSyncContact(env.DB, env.SERVICEM8_API_KEY, loggable);
    } catch (e) {
      console.error("SERVICEM8_SYNC_THREW", JSON.stringify({ callId: call.id, error: String(e) }));
      outcome = "failed";
    }

    if (outcome === "failed") {
      // Release the claim so a later tick retries -- the usual cause is a key that is missing or
      // has been revoked, which is fixed outside this code and then just starts working.
      await env.DB.prepare("UPDATE calls SET servicem8_synced_at = NULL WHERE id = ?").bind(call.id).run();
    }
  }
}

import { getMissedCallSms } from "../db/settings";
import { resolveSendingNumber } from "../db/phoneNumbers";
import { sendSms } from "../twilio/smsClient";
import { insertMessage } from "../db/messages";
import { threadPeer } from "./messages";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  // US1-region API key -- the Messages API is US1-only. Absent on a worker that has never had SMS
  // configured, which is a silent no-op here, exactly like every other SMS send site.
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
  TWILIO_FROM_NUMBER: string;
  TWILIO_SMS_NUMBER?: string;
};

// Called from ONE place: the caller leg's own terminal status callback (`/webhooks/twilio/status`,
// configured on the Twilio number). That is the only moment the call is genuinely over, and being
// genuinely over is the whole requirement -- a customer must not be texted "sorry we missed you"
// while they are still on the phone to us.
//
// It used to be called from CallSession as well, on the voicemail `<Record>` action and the
// callback request, because those paths stamp `calls.ended_at` themselves and the webhook's send
// sat behind that same `ended_at IS NULL` write (0 rows changed -> never ran). But the `<Record>`
// action is NOT the end of a call: the caller is still connected and about to hear "Thanks,
// goodbye", so the text landed on their handset mid-call. The webhook still fires for those calls
// -- `ended_at` being already set only stops it re-stamping the row -- so the send simply moved
// OUT of that guard rather than being duplicated into the IVR.
//
// "Missed" is four shapes, not one:
//   1. `voicemail_left` -- reached a mailbox and recorded something. Never requires `ring_started`:
//      a flow can route straight to voicemail with no ring at all.
//   2. `callback_requested` -- asked for a callback, from a `callback` node OR the * shortcut while
//      held. Also no `ring_started` requirement, for the same reason.
//   3. A `no_answer` logged with reason `mobile_voicemail_answered` -- the async-AMD rescue fired:
//      a staff member's own carrier voicemail picked up the pstn mobile leg, and the caller was
//      pulled back out. That path ALSO writes a real `answered` event (Twilio reports the leg as
//      answered before the AMD verdict is known -- see CallSession.handleAgentAnswer), so shape 4
//      below would otherwise wrongly treat this as "answered" and skip it entirely.
//   4. Reached a ring (`ring_started`) and never got a genuine `answered` event at all -- the plain
//      "rang out, nobody picked up" case, `src/db/calls.ts`'s own definition of missed.
// Hooking the plain webhook alone (shape 4) is deliberate for a DIFFERENT reason: a ring node's
// no-answer branch can lead to ANOTHER ring node, so a caller bridged on a LATER round must never
// be texted "sorry we missed you" mid-conversation -- that call's `answered` event is the real one
// and none of shapes 1-3 will have fired for it.
export async function sendMissedCallSmsIfDue(env: Env, callSid: string): Promise<void> {
  try {
    const setting = await getMissedCallSms(env.DB);
    if (!setting.enabled || !setting.template.trim()) return;
    if (!env.TWILIO_US1_API_KEY_SID || !env.TWILIO_US1_API_KEY_SECRET) return;

    const row = await env.DB.prepare(
      `SELECT caller_number FROM calls c
       WHERE c.id = ? AND c.direction = 'inbound' AND c.missed_sms_sent_at IS NULL
         AND (
           EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'voicemail_left')
           OR EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'callback_requested')
           OR EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'no_answer' AND e.detail LIKE '%mobile_voicemail_answered%')
           OR (
             EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'ring_started')
             AND NOT EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'answered')
           )
         )`
    )
      .bind(callSid)
      .first<{ caller_number: string }>();
    if (!row?.caller_number) return;

    // CLAIM BEFORE SENDING, and release if the send fails. Two callers can reach here for the same
    // call concurrently -- a caller who hangs up during the voicemail recording makes Twilio fire
    // the `<Record>` action and the terminal status callback at the same time, and both are
    // senders (see CallSession's `digits === "hangup"` block) -- so a SELECT that both pass before
    // either writes would text the customer twice. This conditional UPDATE is the only thing that
    // serialises them, so it has to happen before the Twilio call, not after.
    //
    // Claiming first is what the comment here used to reject, for a reason that still stands: the
    // column must record a text that actually WENT OUT, and nothing retries, so a Twilio failure
    // marking a call "texted" forever would be a lie. Hence the release in the catch -- the claim
    // is held only for the length of the send.
    // Resolved BEFORE the claim: it is a read that can throw, and a throw between claiming and the
    // try/catch below would hold the claim forever with no text ever sent.
    const from = (await resolveSendingNumber(env.DB, "sms", null)) ?? env.TWILIO_SMS_NUMBER ?? env.TWILIO_FROM_NUMBER;

    // The same claim also enforces ONE TEXT PER CALLER PER SYDNEY DAY: a customer who rings three
    // times in a row and misses us each time gets one "sorry we missed you", not three. It reads
    // `missed_sms_sent_at` on the caller's other calls rather than the messages table, because the
    // messages insert below is best-effort and can be missing for a text that did go out. Staff's
    // own manual texts do not count. Folded into the UPDATE so two different calls from the same
    // number ending together cannot both pass it. A skipped call keeps the column NULL, so it still
    // means "a text went out for this call".
    const now = Date.now();
    const claim = await env.DB.prepare(
      `UPDATE calls SET missed_sms_sent_at = ? WHERE id = ? AND missed_sms_sent_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM calls p WHERE p.caller_number = ? AND p.id <> ? AND p.missed_sms_sent_at >= ?)`
    )
      .bind(now, callSid, row.caller_number, callSid, sydneyDayStart(now))
      .run();
    if ((claim.meta.changes ?? 0) === 0) {
      console.log("MISSED_CALL_SMS_SKIPPED", JSON.stringify({ callSid, caller: row.caller_number, reason: "this call or this caller already texted today" }));
      return;
    }

    let sid: string;
    try {
      ({ sid } = await sendSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_US1_API_KEY_SID, env.TWILIO_US1_API_KEY_SECRET, {
        to: row.caller_number,
        from,
        body: setting.template,
      }));
    } catch (e) {
      await env.DB.prepare("UPDATE calls SET missed_sms_sent_at = NULL WHERE id = ?").bind(callSid).run();
      throw e;
    }

    // Deliberately its own try/catch, same reasoning as handleSendMessage: Twilio has already
    // accepted the message by this point, so a D1 failure here must not be reported as a send
    // failure (there's nothing to report it TO -- this runs off a webhook, not a staff request) --
    // it would only mean the text silently never appears in the caller's thread in the inbox.
    try {
      await insertMessage(env.DB, {
        id: sid,
        direction: "outbound",
        peer_number: threadPeer(row.caller_number),
        our_number: from,
        body: setting.template,
        status: "sent",
        read: 1,
        createdAt: Date.now(),
      });
    } catch (e) {
      console.log(
        "MISSED_CALL_SMS_INSERT_FAILED",
        JSON.stringify({ callSid, sid, error: e instanceof Error ? e.message : String(e) })
      );
    }
  } catch (e) {
    // Best-effort, like every other notification off the call path (notifyMissedCall,
    // notifyVoicemail): never let this break the status webhook Twilio is waiting on.
    console.log("MISSED_CALL_SMS_FAILED", JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) }));
  }
}

// Epoch ms of the most recent midnight in Australia/Sydney. The timezone is a local constant for the
// same reason as `dial/onCall.ts`: this is a decision, not a label, so it does not import from
// src/html/. The offset is read AT the midnight guess, not at `now`: on a daylight-saving day the
// two differ by an hour. Sydney's transitions happen at 2-3am, never at midnight, so one refinement
// is exact.
export function sydneyDayStart(now: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // Sydney's UTC offset at `t`, rounded to the minute: formatToParts drops the milliseconds.
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((wall - t) / 60000) * 60000;
  };
  const wallNow = now + offset(now);
  const midnightAsUtc = wallNow - (((wallNow % 86400000) + 86400000) % 86400000);
  const guess = midnightAsUtc - offset(now);
  return midnightAsUtc - offset(guess);
}

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

// Called from every place a call reaches its actual end -- the caller-leg's own status webhook
// (CallStatus completed/etc, on the first terminal delivery only -- see the `ended_at IS NULL`
// guard at each call site) AND the two paths in CallSession that end a call directly, WITHOUT ever
// going through that webhook: the voicemail `<Record>` handoff and `recordCallbackRequest` both set
// `calls.ended_at` themselves the instant they run, well before Twilio's own terminal status
// callback arrives -- so by the time that callback lands, `ended_at IS NULL` is already false and
// the status-webhook call site never fires. A caller who left a voicemail or asked for a callback
// therefore got NO text at all until this function was reachable from all three places.
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

    const from = (await resolveSendingNumber(env.DB, "sms", null)) ?? env.TWILIO_SMS_NUMBER ?? env.TWILIO_FROM_NUMBER;
    const { sid } = await sendSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_US1_API_KEY_SID, env.TWILIO_US1_API_KEY_SECRET, {
      to: row.caller_number,
      from,
      body: setting.template,
    });

    // Claimed AFTER the send succeeds, not before: the column is a record of a text that actually
    // went out, not an attempt. Nothing here retries a failure, so claiming first would have let a
    // Twilio error permanently mark a call "sent" when it wasn't. The `IS NULL` guard still means
    // this can never double-claim, and the caller already guarantees a single execution per call
    // (the status webhook only reaches here on the first terminal delivery) -- this is the same
    // belt-and-suspenders the rest of this codebase applies anywhere a bug could reach a customer
    // twice, not the primary defence.
    await env.DB.prepare("UPDATE calls SET missed_sms_sent_at = ? WHERE id = ? AND missed_sms_sent_at IS NULL")
      .bind(Date.now(), callSid)
      .run();

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

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

// Called from the caller-leg's own status webhook once a call is genuinely OVER (CallStatus
// completed/etc, and only on the first terminal delivery -- see the `ended_at IS NULL` guard at
// the call site). "Missed" here is the one definition this system already uses for a missed call
// (src/db/calls.ts: inbound, no `answered` event) plus one addition: the call must have actually
// reached a ring (`ring_started`), so a wrong number who hangs up during the greeting -- or a call
// this DID answer, just on a LATER ring round than the one that first timed out -- never gets
// texted. Hooking here rather than CallSession's `notifyMissedOnce` (which fires at the first
// no-answer ROUND, not the call's actual end) is deliberate: a caller who presses on and gets
// bridged on a second ring round must never receive "sorry we missed you" mid-conversation.
export async function sendMissedCallSmsIfDue(env: Env, callSid: string): Promise<void> {
  try {
    const setting = await getMissedCallSms(env.DB);
    if (!setting.enabled || !setting.template.trim()) return;
    if (!env.TWILIO_US1_API_KEY_SID || !env.TWILIO_US1_API_KEY_SECRET) return;

    const row = await env.DB.prepare(
      `SELECT caller_number FROM calls c
       WHERE c.id = ? AND c.direction = 'inbound' AND c.missed_sms_sent_at IS NULL
         AND EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'ring_started')
         AND NOT EXISTS(SELECT 1 FROM call_events e WHERE e.call_id = c.id AND e.event_type = 'answered')`
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

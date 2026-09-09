import { getPushTokensForType, deletePushTokens } from "../db/pushTokens";
import { sendExpoPush } from "../push/expoPush";
import { getFbChannelAlertLastSent, setFbChannelAlertLastSent } from "../db/settings";

// Cron sweep (runs alongside the other 5-minute sweeps): watches REAL Messenger send outcomes for
// a channel-wide break like error 63001 ("Channel authentication failed" -- the Twilio<->Facebook
// Page connection itself, not any one recipient). No synthetic test messages are sent: this only
// reacts to actual traffic, so a channel break during a quiet period goes unnoticed until the next
// real send is attempted. That's an accepted tradeoff against the cost/noise of probing on a timer.
//
// Per-message failures already page staff via notifyMessageFailed at send time; this exists to
// escalate a SUSTAINED break with one louder, deduped alert instead of staff getting paged once per
// failed message during a whole outage.
const WINDOW_MS = 15 * 60 * 1000;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// How many failures in the window count as CHANNEL-wide rather than one bad recipient.
//
// This was 1, which made the alert self-defeating: replying to a customer outside Meta's 24-hour
// window fails for that recipient alone, and one of those fired "Facebook Messenger may be down"
// and then armed the six-hour cooldown -- so a real channel break starting a minute later stayed
// silent until the afternoon. Three in fifteen minutes is a pattern; one is a Tuesday.
export const CHANNEL_FAILURE_THRESHOLD = 3;

type Env = { DB: D1Database };

export async function checkMessengerChannelHealth(env: Env, now = Date.now()): Promise<void> {
  const recentFailures = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages
      WHERE peer_number LIKE 'messenger:%' AND direction = 'outbound'
        AND status IN ('failed', 'undelivered') AND created_at > ?`
  )
    .bind(now - WINDOW_MS)
    .first<{ n: number }>();
  const count = recentFailures?.n ?? 0;
  if (count < CHANNEL_FAILURE_THRESHOLD) return;

  const lastSent = await getFbChannelAlertLastSent(env.DB);
  if (now - lastSent < ALERT_COOLDOWN_MS) return;

  const tokens = await getPushTokensForType(env.DB, "notif_sms");
  // Nobody to tell is not the same as having told them. Stamping the cooldown here anyway meant an
  // alert that reached no handset -- everyone with notif_sms off, or no device registered -- still
  // suppressed the next six hours of them, so the outage went unreported for a working day.
  if (tokens.length === 0) {
    console.log("FB_CHANNEL_ALERT_NO_DEVICES", JSON.stringify({ count }));
    return;
  }
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: "Facebook Messenger may be down",
    body: `${count} messages failed to send in the last 15 minutes. Check Twilio Console > Messaging > Senders > reconnect the Facebook Page.`,
    data: { type: "channel_health", channel: "messenger" },
  });
  if (invalidTokens.length) await deletePushTokens(env.DB, invalidTokens);
  await setFbChannelAlertLastSent(env.DB, now);
}

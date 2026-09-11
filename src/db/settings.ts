import type { BusinessHoursSchedule } from "../ivr/businessHours";

const BUSINESS_HOURS_KEY = "business_hours";

const DEFAULT_SCHEDULE: BusinessHoursSchedule = {
  mon: { open: "07:00", close: "17:00" },
  tue: { open: "07:00", close: "17:00" },
  wed: { open: "07:00", close: "17:00" },
  thu: { open: "07:00", close: "17:00" },
  fri: { open: "07:00", close: "17:00" },
  sat: { open: "08:00", close: "12:00" },
  sun: null,
};

export async function getBusinessHours(db: D1Database): Promise<BusinessHoursSchedule> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(BUSINESS_HOURS_KEY)
    .first<{ value: string }>();
  if (!row) return DEFAULT_SCHEDULE;
  return JSON.parse(row.value) as BusinessHoursSchedule;
}

export async function setBusinessHours(db: D1Database, schedule: BusinessHoursSchedule): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(BUSINESS_HOURS_KEY, JSON.stringify(schedule))
    .run();
}

const CALL_BLOCKLIST_KEY = "call_blocklist";

export async function getCallBlocklist(db: D1Database): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(CALL_BLOCKLIST_KEY).first<{ value: string }>();
  if (!row) return [];
  return JSON.parse(row.value) as string[];
}

export async function setCallBlocklist(db: D1Database, numbers: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(CALL_BLOCKLIST_KEY, JSON.stringify(numbers))
    .run();
}

const RECORDING_ENABLED_KEY = "recording_enabled";

export async function getRecordingEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(RECORDING_ENABLED_KEY).first<{ value: string }>();
  if (!row) return true; // default ON
  return JSON.parse(row.value) === true;
}

export async function setRecordingEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(RECORDING_ENABLED_KEY, JSON.stringify(enabled))
    .run();
}

// Dedupe timestamp for the Messenger-channel-health cron alert (see checkMessengerChannelHealth) --
// without this, a sustained outage would re-page staff every 5 minutes.
const FB_CHANNEL_ALERT_KEY = "fb_channel_alert_last_sent";

export async function getFbChannelAlertLastSent(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(FB_CHANNEL_ALERT_KEY).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as number) : 0;
}

export async function setFbChannelAlertLastSent(db: D1Database, ts: number): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(FB_CHANNEL_ALERT_KEY, JSON.stringify(ts))
    .run();
}

const TRANSCRIPT_STAFF_CHANNEL_KEY = "transcript_staff_channel";

// Which audio channel the STAFF member is on in a dual-channel recording, for labelling
// speaker-separated transcripts.
//
// DEFAULT 1, and the reason changed on 2026-09-12. The recording moved from the <Conference> noun to
// `record-from-answer-dual` on the <Dial> (see conferenceTwiml.ts for why -- the account-wide Console
// switch that governs conference channel count was enabled, saved, and still producing mono). A Dial
// recording puts channel 1 on the PARENT call, and that document belongs to the staff leg, so staff
// are channel 1 and the conference -- the caller -- is channel 2. Deterministic.
//
// Before that it defaulted to 2, because a CONFERENCE recording gives channel 1 to whoever joined
// first and our answer path awaits the caller's redirectCall into /join-conference before returning
// the staff leg's document. That was a race we were reading tea leaves about, not a rule -- an even
// earlier version hardcoded the opposite and would have labelled every transcript backwards while
// presenting it as fact. This is now a property of which leg owns the <Dial>, which is not a race.
//
// It stays a SETTING regardless, because the cost of being wrong is a transcript that confidently
// attributes the customer's words to staff, and one stored row beats a deploy.
export async function getTranscriptStaffChannel(db: D1Database): Promise<1 | 2> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(TRANSCRIPT_STAFF_CHANNEL_KEY)
    .first<{ value: string }>();
  if (!row) return 1;
  return JSON.parse(row.value) === 2 ? 2 : 1;
}

export async function setTranscriptStaffChannel(db: D1Database, channel: 1 | 2): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(TRANSCRIPT_STAFF_CHANNEL_KEY, JSON.stringify(channel))
    .run();
}

// Whether a call diverted to a staff member's mobile shows the CUSTOMER's number rather than the
// business one. On, the ringing screen answers "who is this?" before you pick up (and matches a
// saved contact, so a regular customer rings by name); off, it says the business number, which is
// what the phone's own contacts resolve to "TCB Phone".
//
// It is a setting because the trade is real and only Phill can judge it: with it ON, a MISSED
// divert sits in the phone's own call log looking like an ordinary unknown number rather than a
// work call. (The app's Recents is the authoritative missed-call list either way, and marks them
// red.) It is also unproven against Australian carriers -- see dialStaff, which falls back to the
// business number if Twilio rejects the caller ID rather than dropping the leg.
const DIVERT_CALLER_ID_KEY = "divert_caller_id";

export async function getDivertCallerId(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(DIVERT_CALLER_ID_KEY).first<{ value: string }>();
  if (!row) return true; // default ON -- knowing who is calling before answering is the point
  return JSON.parse(row.value) === true;
}

export async function setDivertCallerId(db: D1Database, enabled: boolean): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(DIVERT_CALLER_ID_KEY, JSON.stringify(enabled))
    .run();
}

// The last time Twilio refused to let a divert leg present the customer's number, so Admin > Health
// Checks can say the feature is silently falling back to the business number.
//
// Nothing else would say so. The fallback is deliberately invisible to the caller and to staff --
// the phone still rings, the call still connects -- so without this the only evidence is a log line
// nobody is watching. That is the shape SERVICEM8_API_KEY failed in for a day.
const DIVERT_CALLER_ID_ERROR_KEY = "divert_caller_id_last_error";

export type DivertCallerIdRejection = { at: number; status: number };

export async function recordDivertCallerIdRejection(db: D1Database, status: number): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(DIVERT_CALLER_ID_ERROR_KEY, JSON.stringify({ at: Date.now(), status } satisfies DivertCallerIdRejection))
    .run();
}

// Cleared on a successful divert, so the check reports CURRENT state. Without this one anonymous
// caller or one transient 400 leaves Admin > Health Checks reporting a failure for seven days while
// every divert works -- and a check that cannot recover is worse than no check, because it teaches
// you to ignore it.
export async function clearDivertCallerIdRejection(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(DIVERT_CALLER_ID_ERROR_KEY).run();
}

export async function getDivertCallerIdRejection(db: D1Database): Promise<DivertCallerIdRejection | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(DIVERT_CALLER_ID_ERROR_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as DivertCallerIdRejection;
  } catch {
    return null;
  }
}

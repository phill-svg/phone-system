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

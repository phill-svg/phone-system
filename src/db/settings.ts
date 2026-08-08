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

export type StaffRingEntry = { label: string; number: string };

const STAFF_RING_LIST_KEY = "staff_ring_list";

export async function getStaffRingList(db: D1Database): Promise<StaffRingEntry[]> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(STAFF_RING_LIST_KEY)
    .first<{ value: string }>();
  if (!row) return [];
  return JSON.parse(row.value) as StaffRingEntry[];
}

export async function setStaffRingList(db: D1Database, list: StaffRingEntry[]): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(STAFF_RING_LIST_KEY, JSON.stringify(list))
    .run();
}

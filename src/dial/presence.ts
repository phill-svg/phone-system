import type { BusinessHoursSchedule } from "../ivr/businessHours";
import { isWithinBusinessHours } from "../ivr/businessHours";

export type StaffStatus = "available" | "away" | "offline";

export type StaffPresenceRow = {
  email: string;
  role: "admin" | "staff";
  status: StaffStatus;
  awayReason: string | null;
  schedule: BusinessHoursSchedule;
  lastHeartbeatAt: number | null;
};

export const HEARTBEAT_STALE_MS = 60_000;

export function isStaffAvailable(staff: StaffPresenceRow, now: Date): boolean {
  if (staff.status !== "available") return false;
  if (staff.lastHeartbeatAt === null) return false;
  if (now.getTime() - staff.lastHeartbeatAt > HEARTBEAT_STALE_MS) return false;
  return isWithinBusinessHours(staff.schedule, now);
}

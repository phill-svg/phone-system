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
  // Cascade ring priority: lower rings earlier. Defaults to 100.
  ringPriority: number;
};

// Browsers throttle setInterval/setTimeout heavily in backgrounded tabs -- a staff member
// switching away from /phone to actually take a call on their phone, or just glancing at
// another app, can easily cause the 20s heartbeat ping to stop firing reliably for several
// minutes even though they're still genuinely available. 60s was too tight for this completely
// normal behavior and caused real calls to skip ringing entirely. 5 minutes still catches a
// truly closed/crashed tab in a reasonable time, without punishing brief inattention.
export const HEARTBEAT_STALE_MS = 5 * 60_000;

// On-shift = available and within business hours. Deliberately ignores the softphone heartbeat:
// used to decide whether to ring a staff member's personal MOBILE, which should reach them even
// when their softphone/app is closed (see ring-my-mobile).
export function isOnShift(staff: StaffPresenceRow, now: Date): boolean {
  if (staff.status !== "available") return false;
  return isWithinBusinessHours(staff.schedule, now);
}

// Reachable via SOFTPHONE right now = on-shift AND a fresh heartbeat proves the app is online.
export function isStaffAvailable(staff: StaffPresenceRow, now: Date): boolean {
  if (!isOnShift(staff, now)) return false;
  if (staff.lastHeartbeatAt === null) return false;
  return now.getTime() - staff.lastHeartbeatAt <= HEARTBEAT_STALE_MS;
}

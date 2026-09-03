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

// How old a heartbeat may be before the softphone is treated as offline for DISPLAY purposes.
// No longer gates ringing -- see isStaffAvailable below.
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export function hasFreshHeartbeat(staff: StaffPresenceRow, now: Date): boolean {
  if (staff.lastHeartbeatAt === null) return false;
  return now.getTime() - staff.lastHeartbeatAt <= HEARTBEAT_STALE_MS;
}

// On-shift = available and within business hours. Deliberately ignores the softphone heartbeat:
// used to decide whether to ring a staff member's personal MOBILE, which should reach them even
// when their softphone/app is closed (see ring-my-mobile).
export function isOnShift(staff: StaffPresenceRow, now: Date): boolean {
  if (staff.status !== "available") return false;
  return isWithinBusinessHours(staff.schedule, now);
}

// Reachable via SOFTPHONE right now = on-shift. Deliberately NO heartbeat requirement.
//
// The heartbeat only ticks while the app is in the foreground, so requiring a fresh one meant a
// staff member was rung only if their app happened to be open -- which, for people out on jobs
// with the phone in a pocket, is almost never. They were silently absent from the roster during
// their own shift.
//
// Incoming calls reach a closed app by VoIP push (iOS PushKit, FCM on Android): the OS wakes the
// app for the call. That is the entire purpose of the push credential, and it is confirmed working
// on-device. So the heartbeat is no longer evidence of reachability -- it only ever proved the app
// was in the foreground.
//
// If a device really is unregistered, Twilio fails that leg promptly and the cascade moves to the
// next person, which costs a caller a few seconds. Never ringing someone who is on shift costs
// the call. Presence is still respected: `away`/`offline` and the person's own schedule both
// still exclude them.
export function isStaffAvailable(staff: StaffPresenceRow, now: Date): boolean {
  return isOnShift(staff, now);
}

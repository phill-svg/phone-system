import { getStaffRoster } from "../db/staff";
import { isStaffAvailable } from "./presence";

export type RingNodeTarget = "all" | string[];

// Normalizes a user-entered mobile number to a diallable E.164 form for Twilio (AU-focused).
//   "0412 345 678" -> "+61412345678"
//   "+61412345678" -> unchanged
//   "61412345678"  -> "+61412345678"
// Returns null if there aren't enough digits to be a real number.
export function toDiallableNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed.replace(/[^\d+]/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 6) return null;
  if (digits.startsWith("0")) return "+61" + digits.slice(1);
  if (digits.startsWith("61")) return "+" + digits;
  return "+" + digits;
}

// Resolves the ordered list of legs to ring for a ring node. For each currently-available staff
// member (softphone online + within their hours) we emit their `client:{email}` softphone leg
// followed by their mobile number (if set) as a failover leg. With the cascade strategy this rings
// the softphone first, then the mobile on no-answer; with simultaneous it rings both at once.
export async function resolveRingTargets(db: D1Database, target: RingNodeTarget, now: Date): Promise<string[]> {
  const roster = await getStaffRoster(db);
  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  const available = candidates.filter((s) => isStaffAvailable(s, now));

  // Ring in priority order (lower rings earlier); email is a stable tiebreaker within a tier.
  available.sort((a, b) => a.ringPriority - b.ringPriority || a.email.localeCompare(b.email));

  const legs: string[] = [];
  for (const staff of available) {
    legs.push(`client:${staff.email}`);
    if (staff.mobileNumber) {
      const dial = toDiallableNumber(staff.mobileNumber);
      if (dial) legs.push(dial);
    }
  }
  return legs;
}

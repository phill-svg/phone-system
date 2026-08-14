import { getStaffRoster } from "../db/staff";
import { isStaffAvailable } from "./presence";

export type RingNodeTarget = "all" | string[];

// Resolves the ordered list of softphone legs to ring for a ring node: each currently-available
// staff member (softphone online + within their hours) as a `client:{email}` identity, ordered by
// ring priority (lower rings earlier). Staff are only ever reached via their browser softphone --
// the system deliberately does not dial personal mobile numbers.
export async function resolveRingTargets(db: D1Database, target: RingNodeTarget, now: Date): Promise<string[]> {
  const roster = await getStaffRoster(db);
  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  const available = candidates.filter((s) => isStaffAvailable(s, now));

  // Ring in priority order (lower rings earlier); email is a stable tiebreaker within a tier.
  available.sort((a, b) => a.ringPriority - b.ringPriority || a.email.localeCompare(b.email));

  return available.map((s) => `client:${s.email}`);
}

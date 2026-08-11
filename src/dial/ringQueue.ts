import { getStaffRoster } from "../db/staff";
import { isStaffAvailable } from "./presence";

export type RingNodeTarget = "all" | string[];

export async function resolveRingTargets(db: D1Database, target: RingNodeTarget, now: Date): Promise<string[]> {
  const roster = await getStaffRoster(db);
  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  return candidates.filter((s) => isStaffAvailable(s, now)).map((s) => `client:${s.email}`);
}

import type { StaffRingEntry } from "../db/settings";

export type RingNodeTarget = "all" | "on_call_only";

export function resolveRingTargets(target: RingNodeTarget, ringList: StaffRingEntry[]): string[] {
  if (target === "all") return ringList.map((e) => e.number);
  return ringList.filter((e) => e.isOnCall).map((e) => e.number);
}

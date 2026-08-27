import { getStaffRoster } from "../db/staff";
import { isStaffAvailable, isOnShift } from "./presence";
import { getUserSettings, normalizeMobileE164 } from "../db/userSettings";

export type RingNodeTarget = "all" | string[];

// Resolves the ordered list of legs to ring for a ring node. Softphone legs (`client:{email}`) are
// emitted for staff whose app is online (isStaffAvailable). Personal-mobile legs
// (`pstn:{email}|{e164}`) are additionally emitted for staff who enabled ring-my-mobile and are
// on-shift (available + within hours) — even if their softphone is offline, so the call reaches
// their cell when the app is closed. Client legs first (by ring priority), then pstn legs.
export async function resolveRingTargets(db: D1Database, target: RingNodeTarget, now: Date): Promise<string[]> {
  const roster = await getStaffRoster(db);
  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  const onShift = candidates.filter((s) => isOnShift(s, now));
  onShift.sort((a, b) => a.ringPriority - b.ringPriority || a.email.localeCompare(b.email));

  const clientLegs: string[] = [];
  const pstnLegs: string[] = [];
  for (const s of onShift) {
    if (isStaffAvailable(s, now)) clientLegs.push(`client:${s.email}`);
    const prefs = await getUserSettings(db, s.email);
    if (prefs.ring_my_mobile) {
      const e164 = normalizeMobileE164(prefs.mobile_number);
      if (e164) pstnLegs.push(`pstn:${s.email}|${e164}`);
    }
  }
  return [...clientLegs, ...pstnLegs];
}

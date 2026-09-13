import type { RosterEntry } from "./api";

// Who a call can be handed to: every colleague except the person holding it.
export function transferTargets(roster: RosterEntry[], selfEmail: string | undefined): RosterEntry[] {
  const self = selfEmail?.toLowerCase();
  return roster.filter((s) => s.email.toLowerCase() !== self);
}

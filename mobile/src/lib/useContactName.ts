import { useQuery } from "@tanstack/react-query";
import { getContacts } from "./api";
import { contactForNumber } from "./phone";

// The saved contact name for a number, for screens that are handed a raw number.
//
// The ringing and in-call screens used to show whatever `name` was passed in the route params --
// and the two places that open the ringing screen pass "". So a caller already in the contact book
// rang as a bare number, even though the push notification that announced them was named (the
// server resolves that one). Every other list in the app resolves names this way; these two didn't.
//
// Same query key as everywhere else, so this shares the cached contact list rather than refetching.
// On a cold start from a VoIP push the list may still be in flight: the number shows first and the
// name replaces it a moment later, which is the right way round.
export function useContactName(number: string, passed?: string): string {
  const { data } = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });
  const explicit = (passed ?? "").trim();
  if (explicit) return explicit;
  return contactForNumber(number, data ?? [])?.name ?? "";
}

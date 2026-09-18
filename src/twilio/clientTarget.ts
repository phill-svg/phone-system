// Builds the `To` for a Twilio call that terminates at a Voice SDK client.
//
// Twilio's `From` on a `client:` leg is always OUR business number -- the raw external caller is
// never risked there, because caller-ID-ownership rules for a client destination are murky. So the
// custom Client parameters below are the only thing that tells a handset who is calling.
//
// TWO parameters, because the two consumers need different things. `CallerNumber` is the raw number
// the app uses to call back, match a contact and normalise; `CallerName` is what a human should
// READ, which is the saved contact's name when there is one and the number when there is not.
//
// `CallerName` is ALWAYS present when a caller is known. iOS builds its CallKit banner natively,
// before any JS runs, by substituting one global template (`${CallerName}`) -- so a leg that omits
// the key renders the template literally on the lock screen. Falling back to the number keeps that
// resolvable without ever asserting something false, which is the trap the business-number fallback
// fell into: every reader prefers these parameters over `From`, so a wrong value here beats a right
// one everywhere at once.
export function clientDialTarget(
  identity: string,
  caller: { number?: string | null; name?: string | null }
): string {
  const number = caller.number ? caller.number.replace(/^\+/, "") : null;
  // Bare digits, no leading "+": whether Twilio decodes this client-URI query value zero or one
  // times before the client reads it back is unverified, and a "+" is ambiguous either way (it can
  // decode to a literal space). Digits-only survives both interpretations identically.
  //
  // encodeURIComponent, NOT URLSearchParams: URLSearchParams writes a space as "+", and a contact
  // name nearly always has one. Neither Twilio's client-parameter decoding nor iOS's native
  // substitution into the CallKit template can be relied on to turn "+" back into a space, so the
  // lock screen -- which no JavaScript can correct -- would read "Jane+Customer". "%20" is
  // unambiguous under any percent-decoder.
  const parts: string[] = [];
  if (number) parts.push(`CallerNumber=${encodeURIComponent(number)}`);
  const name = caller.name?.trim();
  if (number || name) parts.push(`CallerName=${encodeURIComponent(name || (number as string))}`);
  return parts.length ? `client:${identity}?${parts.join("&")}` : `client:${identity}`;
}

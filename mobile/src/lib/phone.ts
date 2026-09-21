import type { Contact } from "./api";

// Digits-only canonical form for matching, tuned for AU numbers. MUST match the backend's
// normalizePhone() in src/db/contacts.ts (and the web copy in src/html/pages/phone.ts) EXACTLY,
// because contacts are matched against the stored `phone_normalized`, which the backend writes in
// international 61x form (e.g. "61400123456", NOT "0400123456"). A "+" means already-international;
// a leading 0 is the AU national trunk prefix that becomes "61".
export function normalizePhone(raw: string): string {
  if (!raw) return "";
  const hasPlus = raw.trim().charAt(0) === "+";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return digits;
  if (digits.charAt(0) === "0") return "61" + digits.slice(1);
  return digits;
}

// E.164 form ("+61400123456"). Twilio reports a call's `From` this way, and the call blocklist is
// matched as a literal string against it (src/worker.ts: blocklist.includes(params.From)) -- so an
// entry typed as "0400 123 456" only ever blocks anyone once it is stored in this shape.
//
// 1300/1800 and 13xx numbers carry no trunk 0, so normalizePhone leaves them bare and they would come
// out as "+1300...". Fixed HERE rather than in normalizePhone, which has to stay identical to the
// backend copy that wrote every stored contact's phone_normalized.
export function toE164(raw: string): string {
  const digits = normalizePhone(raw);
  if (!digits) return "";
  return /^(1[38]00\d{6}|13\d{4})$/.test(digits) ? `+61${digits}` : `+${digits}`;
}

// Pretty display for AU numbers; falls back to loose 3/4 grouping otherwise.
export function formatPhone(raw: string): string {
  const d = raw.replace(/[^\d+]/g, "");
  const n = d.startsWith("+61") ? "0" + d.slice(3) : d;
  if (/^04\d{8}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`; // mobile
  if (/^0[2378]\d{8}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`; // landline
  if (/^13\d{4}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2)}`; // 13xxxx
  if (/^1[38]00\d{6}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`; // 1300/1800
  return raw;
}

// Recents, filtered by what was typed in the search box.
//
// Matched against the SAME two things the row shows -- the saved contact's name and the other
// party's number -- because a list that hides a row whose visible text contains the query reads as
// broken. The number is matched on digits (via normalizePhone), so "0402", "402" and "+61402" all
// find the same call however it was stored or displayed.
//
// `nameFor` is supplied by the caller rather than looked up here: the screen already resolves each
// call to a contact name for display, and doing it twice would let the two drift.
export function searchCalls<T extends { direction: string; caller_number: string; called_number: string }>(
  query: string,
  calls: T[],
  nameFor: (call: T) => string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return calls;
  // BOTH forms, because `normalizePhone` is a whole-number transform being used on a fragment:
  // it rewrites a leading 0 to 61, so typing "05 9771" -- contiguous text visible on the row for
  // 02 6105 9771 -- becomes "6159771", which is in no stored number. The raw digits match that;
  // the normalised form matches a number typed in a different shape from the stored one.
  const digits = normalizePhone(query);
  const raw = query.replace(/\D/g, "");
  // Gated on the RAW length. `normalizePhone("0")` is "61", so a length check on the normalised
  // form lets a single typed 0 -- the first keystroke of every AU number -- match every row.
  const numberSearch = raw.length >= 2;
  return calls.filter((c) => {
    if (nameFor(c).toLowerCase().includes(needle)) return true;
    if (!numberSearch) return false;
    const number = normalizePhone(c.direction === "outbound" ? c.called_number : c.caller_number);
    return number.includes(digits) || number.includes(raw);
  });
}

// Contacts whose number contains the typed digits — keypad suggestions.
export function matchContacts(typed: string, contacts: Contact[], limit = 3): Contact[] {
  const digits = normalizePhone(typed);
  if (digits.length < 2) return [];
  return contacts.filter((c) => c.phone_normalized.includes(digits)).slice(0, limit);
}

// Resolve a call's number to a saved contact name, if any.
export function contactForNumber(number: string, contacts: Contact[]): Contact | undefined {
  const digits = normalizePhone(number);
  if (!digits) return undefined;
  // The suffix pass needs a real number on both sides: `x.endsWith("")` is always true, so a contact
  // saved with "TBC" as its phone named every unknown caller, and a short code named everyone ending
  // in it. 8 digits is a full local number without its area code.
  return (
    contacts.find((c) => c.phone_normalized === digits) ??
    (digits.length < MIN_SUFFIX_DIGITS
      ? undefined
      : contacts.find(
          (c) =>
            c.phone_normalized.length >= MIN_SUFFIX_DIGITS &&
            (c.phone_normalized.endsWith(digits) || digits.endsWith(c.phone_normalized))
        ))
  );
}
const MIN_SUFFIX_DIGITS = 8;

// Contact search for a "who am I messaging/calling" picker -- matches on name, company OR digits,
// unlike matchContacts above (digits only, for the keypad's live-dial suggestions). An empty query
// returns everything, so a picker can show the full list on focus before the person types anything.
export function searchContacts(query: string, contacts: Contact[]): Contact[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return contacts;
  const digits = normalizePhone(query);
  return contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(needle) ||
      (c.company ?? "").toLowerCase().includes(needle) ||
      (digits.length >= 2 && c.phone_normalized.includes(digits))
  );
}

// A blocklist entry, in the form the IVR compares against.
//
// Twilio reports the caller in E.164 and `src/worker.ts` matches the list LITERALLY
// (`blocklist.includes(params.From)`), so "0400 123 456" has to be stored as "+61400123456" or it
// blocks nobody. Anything `toE164` cannot make sense of is kept verbatim rather than mangled --
// a short code or an alphanumeric sender is still something an admin may want to block.
export function normalizeBlocklistEntry(raw: string): string {
  const trimmed = raw.trim();
  return toE164(trimmed) || trimmed;
}

// The blocklist as it would be SAVED, including a number still sitting unadded in the entry box.
//
// Tapping Save without tapping + used to discard that number silently, while the button read
// "Saved" -- so the admin believed a caller was blocked who was not. Deduplicated, because the
// same number may already be on the list.
export function withPendingEntry(numbers: string[], entry: string): string[] {
  const pendingEntry = normalizeBlocklistEntry(entry);
  if (!pendingEntry || numbers.includes(pendingEntry)) return numbers;
  return [...numbers, pendingEntry];
}

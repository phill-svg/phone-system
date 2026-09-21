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
  const digits = normalizePhone(query);
  return calls.filter((c) => {
    const number = c.direction === "outbound" ? c.called_number : c.caller_number;
    if (nameFor(c).toLowerCase().includes(needle)) return true;
    // Two digits is where a number search stops matching half the call log. Below that the name
    // match above is the only sensible reading of what was typed.
    return digits.length >= 2 && normalizePhone(number).includes(digits);
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

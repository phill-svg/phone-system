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
  return contacts.find((c) => c.phone_normalized === digits) ?? contacts.find((c) => c.phone_normalized.endsWith(digits) || digits.endsWith(c.phone_normalized));
}

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

import type { Contact } from "./api";

// Digits-only canonical form for matching, tuned for AU numbers: strip formatting
// and fold +61 / 61 international prefixes to the national 0x form so a typed
// "0400…" matches a stored "+61400…". Mirrors the backend's normalisation.
export function normalizePhone(raw: string): string {
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+61")) d = "0" + d.slice(3);
  else if (d.startsWith("61") && d.length > 9) d = "0" + d.slice(2);
  return d.replace(/\D/g, "");
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

// Display an AU phone number in national grouped form: +61 / 61 international prefixes fold to a
// leading 0, grouped like "0472 762 158" (mobile) or "02 8395 3312" (landline). Mirrors the
// client-side formatAu() copies in html/pages/phone.ts and html/pages/messages.ts. Matching still
// happens on the international 61x form (see db/contacts.ts normalizePhone) — this is display only.
export function formatAuNumber(raw: string): string {
  const s = String(raw ?? "");
  const d = s.replace(/[^\d+]/g, "");
  let n: string;
  if (d.charAt(0) === "+") n = d.startsWith("+61") ? "0" + d.slice(3) : d;
  else if (d.startsWith("61") && d.length > 9) n = "0" + d.slice(2);
  else n = d;
  if (/^04\d{8}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  if (/^0[2378]\d{8}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  if (/^13\d{4}$/.test(n)) return `${n.slice(0, 2)} ${n.slice(2)}`;
  if (/^1[38]00\d{6}$/.test(n)) return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  return n || s;
}

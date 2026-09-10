const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A week key is a Monday as a Canberra calendar date, already decided by the server. It is rendered
// from its UTC parts on purpose: passing it through `new Date("2026-09-07")` and reading local parts
// shifts it a day for any device west of Sydney, so a handset in Perth -- or one a tech left on a US
// timezone -- would show the rota a day out while the server rang the right person.
export function weekLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const fmt = (x: Date) => `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

export const shortName = (email: string): string => email.split("@")[0];

// Whose turn a given week is, mirroring src/dial/onCall.ts. Duplicated deliberately and kept tiny:
// the screen needs to answer "would saving this change who is on call TONIGHT?" BEFORE it writes,
// and the server can only answer after. Preserving the anchor is not enough on its own -- `size` is
// as load-bearing as the anchor, so adding a fourth tech to a three-person rota re-indexes the
// current week and moves tonight's on-call person with no warning at all.
export function rotationMemberFor(members: string[], anchorWeekStart: string, weekStart: string): string | null {
  if (members.length === 0 || !anchorWeekStart) return null;
  const from = Date.parse(`${anchorWeekStart}T00:00:00Z`);
  const to = Date.parse(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const elapsed = Math.round((to - from) / (7 * 86_400_000));
  const size = members.length;
  return members[((elapsed % size) + size) % size] ?? null;
}

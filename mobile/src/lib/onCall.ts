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

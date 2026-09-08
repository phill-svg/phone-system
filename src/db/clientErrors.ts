export type ClientErrorReport = {
  platform: string;
  otaBuild: string | null;
  appVersion: string | null;
  fatal: boolean;
  name: string | null;
  message: string;
  stack: string | null;
  screen: string | null;
  occurredAt: number;
};

export type ClientErrorRow = {
  id: number;
  staff_email: string | null;
  platform: string;
  ota_build: string | null;
  app_version: string | null;
  fatal: number;
  name: string | null;
  message: string;
  stack: string | null;
  screen: string | null;
  occurred_at: number;
  received_at: number;
};

// A crash report is written by a device that is, by definition, misbehaving. Everything here is
// bounded so a report loop cannot fill the database: the batch size, each field's length, and the
// stack in particular, which is the only field big enough to matter.
export const MAX_REPORTS_PER_BATCH = 20;
const MAX_MESSAGE = 1000;
const MAX_STACK = 8000;
const MAX_SHORT = 200;

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > max ? value.slice(0, max) : value;
}

// Parses one report from an untrusted body. Returns null rather than throwing, so one malformed
// entry in a batch doesn't discard the others -- the good ones are usually the reason we're here.
export function parseClientErrorReport(raw: unknown): ClientErrorReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const message = clamp(r.message, MAX_MESSAGE);
  if (!message) return null;
  const platform = clamp(r.platform, MAX_SHORT) ?? "unknown";
  // A device clock can be wrong or absent. Falling back to "now" keeps the report rather than
  // dropping it, and the received_at column stays the trustworthy one either way.
  const occurredAt =
    typeof r.occurredAt === "number" && Number.isFinite(r.occurredAt) && r.occurredAt > 0
      ? Math.floor(r.occurredAt)
      : Date.now();
  return {
    platform,
    otaBuild: clamp(r.otaBuild, MAX_SHORT),
    appVersion: clamp(r.appVersion, MAX_SHORT),
    fatal: r.fatal === true,
    name: clamp(r.name, MAX_SHORT),
    message,
    stack: clamp(r.stack, MAX_STACK),
    screen: clamp(r.screen, MAX_SHORT),
    occurredAt,
  };
}

export async function recordClientErrors(
  db: D1Database,
  staffEmail: string | null,
  reports: ClientErrorReport[]
): Promise<number> {
  if (reports.length === 0) return 0;
  const receivedAt = Date.now();
  const statements = reports.map((r) =>
    db
      .prepare(
        "INSERT INTO client_errors (staff_email, platform, ota_build, app_version, fatal, name, message, stack, screen, occurred_at, received_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        staffEmail,
        r.platform,
        r.otaBuild,
        r.appVersion,
        r.fatal ? 1 : 0,
        r.name,
        r.message,
        r.stack,
        r.screen,
        r.occurredAt,
        receivedAt
      )
  );
  await db.batch(statements);
  return statements.length;
}

export async function listClientErrors(db: D1Database, limit = 100): Promise<ClientErrorRow[]> {
  const result = await db
    .prepare("SELECT * FROM client_errors ORDER BY occurred_at DESC LIMIT ?")
    .bind(limit)
    .all<ClientErrorRow>();
  return result.results;
}

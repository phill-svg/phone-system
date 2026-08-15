const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export async function isRateLimited(db: D1Database, email: string): Promise<boolean> {
  const since = Date.now() - WINDOW_MS;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND attempted_at > ?")
    .bind(email, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_ATTEMPTS;
}

export async function recordFailedAttempt(db: D1Database, email: string): Promise<void> {
  await db.prepare("INSERT INTO login_attempts (email, attempted_at) VALUES (?, ?)").bind(email, Date.now()).run();
}

export async function clearAttempts(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
}

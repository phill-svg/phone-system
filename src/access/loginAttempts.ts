const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

// Counts this attempt BEFORE the password is checked, in one statement, and answers whether it may
// proceed. Check-then-record let a parallel burst all pass the count while the slow hash ran, so
// one window allowed as many guesses as were sent at once. A success clears the row via clearAttempts.
export async function reserveAttempt(db: D1Database, email: string): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      "INSERT INTO login_attempts (email, attempted_at) SELECT ?, ? " +
        "WHERE (SELECT COUNT(*) FROM login_attempts WHERE email = ? AND attempted_at > ?) < ?"
    )
    .bind(email, now, email, now - WINDOW_MS, MAX_ATTEMPTS)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function clearAttempts(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
}

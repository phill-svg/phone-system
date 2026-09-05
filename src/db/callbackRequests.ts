export type CallbackRequest = {
  id: number;
  call_id: string;
  caller_number: string;
  requested_at: number;
  status: "open" | "done";
  done_at: number | null;
  done_by: string | null;
};

// How many handled requests the app's history section shows by default. Open requests are a work
// queue and are never capped; the done tail is the part that would otherwise grow without limit.
export const DONE_HISTORY_LIMIT = 50;

export async function createCallbackRequest(
  db: D1Database,
  input: { callId: string; callerNumber: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
    .bind(input.callId, input.callerNumber, Date.now())
    .run();
}

export async function listOpenCallbackRequests(db: D1Database): Promise<CallbackRequest[]> {
  const result = await db
    .prepare("SELECT * FROM callback_requests WHERE status = 'open' ORDER BY requested_at DESC")
    .all<CallbackRequest>();
  return result.results;
}

// Every open request, then the most recent `doneLimit` handled ones. Two queries rather than one
// ordered query because the cap applies only to the done tail -- an open request must never fall off
// the end of the list just because a lot of callbacks were handled recently.
export async function listCallbackRequests(
  db: D1Database,
  doneLimit: number = DONE_HISTORY_LIMIT
): Promise<CallbackRequest[]> {
  const done = await db
    .prepare("SELECT * FROM callback_requests WHERE status = 'done' ORDER BY requested_at DESC LIMIT ?")
    .bind(doneLimit)
    .all<CallbackRequest>();
  return [...(await listOpenCallbackRequests(db)), ...done.results];
}

// Flip a request's status. Returns false when no such row exists, so the caller can 404.
// `done_at`/`done_by` are stamped on the way to 'done' and cleared on the way back to 'open' -- a
// reopened request has genuinely not been handled, and a stale "called back by" would say it had.
export async function setCallbackRequestStatus(
  db: D1Database,
  id: number,
  status: "open" | "done",
  staffEmail: string
): Promise<boolean> {
  const result =
    status === "done"
      ? await db
          .prepare("UPDATE callback_requests SET status = 'done', done_at = ?, done_by = ? WHERE id = ?")
          .bind(Date.now(), staffEmail, id)
          .run()
      : await db
          .prepare("UPDATE callback_requests SET status = 'open', done_at = NULL, done_by = NULL WHERE id = ?")
          .bind(id)
          .run();
  return (result.meta.changes ?? 0) > 0;
}

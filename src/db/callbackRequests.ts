export type CallbackRequest = {
  id: number;
  call_id: string;
  caller_number: string;
  requested_at: number;
  status: "open" | "done";
};

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

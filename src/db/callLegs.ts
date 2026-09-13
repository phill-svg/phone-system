// Server-side record of which staff email owns a given softphone CallSid, written whenever the
// server itself dials or receives a leg for a specific staff member (CallSession.dialStaff,
// worker.ts's /twiml/voice-app, and handlePostTransfer's outbound dial). handlePostHold /
// handlePostTransfer / handlePostCompleteTransfer check this record against the AUTHENTICATED
// staff.email before trusting a client-submitted selfCallSid/agentCallSid -- see softphone.ts.
export async function recordCallLeg(
  db: D1Database,
  callSid: string,
  staffEmail: string,
  conferenceName: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO softphone_call_legs (call_sid, staff_email, conference_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(call_sid) DO NOTHING"
    )
    .bind(callSid, staffEmail, conferenceName, Date.now())
    .run();
}

// The conference this staff member's leg sits in, or null when the leg is not theirs. The client
// cannot be asked for it: an inbound call's conference is named after the CALLER's leg.
export async function ownLegConference(db: D1Database, callSid: string, staffEmail: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT conference_name FROM softphone_call_legs WHERE call_sid = ? AND staff_email = ?")
    .bind(callSid, staffEmail)
    .first<{ conference_name: string }>();
  return row?.conference_name ?? null;
}

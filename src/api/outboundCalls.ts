import { jsonResponse } from "./respond";
import { createOutboundCall } from "../twilio/restClient";
import type { StaffUser } from "../access/requireStaffUser";

type Env = {
  DB: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
};

const INVALID_BODY_RESPONSE = () => new Response("invalid request body", { status: 400 });

// Staff-initiated outbound call ("click to call"): ring the staff member's own mobile first,
// then once THEY answer, /webhooks/twilio/click-to-call bridges them out to the customer number
// given here as `to`.
export async function handleCreateOutboundCall(request: Request, env: Env, staff: StaffUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (typeof body !== "object" || body === null) {
    return INVALID_BODY_RESPONSE();
  }
  const { to } = body as Record<string, unknown>;
  if (typeof to !== "string" || to.length === 0) {
    return INVALID_BODY_RESPONSE();
  }

  if (!staff.mobile_number) {
    return new Response("no mobile number on file for this staff account", { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const { sid } = await createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
    to: staff.mobile_number,
    from: env.TWILIO_FROM_NUMBER,
    url: `${origin}/webhooks/twilio/click-to-call?target=${encodeURIComponent(to)}`,
  });

  // `sid` is the REAL Twilio-issued CallSid for the staff leg just created. Use it as calls.id,
  // matching the inbound convention (one real CallSid = one calls row, always) rather than
  // minting a separate app-generated UUID.
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours, status, direction) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(sid, env.TWILIO_FROM_NUMBER, to, Date.now(), 0, "in_progress", "outbound")
    .run();

  return jsonResponse({ id: sid }, 201);
}

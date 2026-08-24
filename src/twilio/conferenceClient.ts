// Conferences are au1-homed (see restClient.ts) -- au1 endpoint, au1 credentials.
const TWILIO_API_BASE = "https://api.sydney.au1.twilio.com";

// Exported: the account-level Basic auth header is also needed outside this module (recording
// fetch for transcription, stale-call reconciliation) — one construction site, not N inlined copies.
export function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${btoa(`${accountSid}:${authToken}`)}`;
}

export async function findConferenceSid(
  accountSid: string,
  authToken: string,
  friendlyName: string
): Promise<string | null> {
  const res = await fetch(
    `${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Conferences.json?FriendlyName=${encodeURIComponent(friendlyName)}`,
    { headers: { Authorization: authHeader(accountSid, authToken) } }
  );
  if (!res.ok) throw new Error(`Twilio list-conferences failed: ${res.status}`);
  const json = await res.json<{ conferences: { sid: string }[] }>();
  return json.conferences[0]?.sid ?? null;
}

export async function listParticipants(
  accountSid: string,
  authToken: string,
  conferenceSid: string
): Promise<{ callSid: string }[]> {
  const res = await fetch(
    `${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants.json`,
    { headers: { Authorization: authHeader(accountSid, authToken) } }
  );
  if (!res.ok) throw new Error(`Twilio list-participants failed: ${res.status}`);
  const json = await res.json<{ participants: { call_sid: string }[] }>();
  return json.participants.map((p) => ({ callSid: p.call_sid }));
}

export async function setParticipantHold(
  accountSid: string,
  authToken: string,
  conferenceSid: string,
  callSid: string,
  hold: boolean
): Promise<void> {
  const res = await fetch(
    `${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Hold: String(hold) }),
    }
  );
  if (!res.ok) throw new Error(`Twilio set-participant-hold failed: ${res.status}`);
}

export async function removeParticipant(
  accountSid: string,
  authToken: string,
  conferenceSid: string,
  callSid: string
): Promise<void> {
  const res = await fetch(
    `${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
    { method: "DELETE", headers: { Authorization: authHeader(accountSid, authToken) } }
  );
  if (!res.ok && res.status !== 204) throw new Error(`Twilio remove-participant failed: ${res.status}`);
}

export async function endConference(accountSid: string, authToken: string, conferenceSid: string): Promise<void> {
  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}.json`, {
    method: "POST",
    headers: {
      Authorization: authHeader(accountSid, authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "completed" }),
  });
  if (!res.ok) throw new Error(`Twilio end-conference failed: ${res.status}`);
}

// A two-party bridge has no reason to outlive its second-to-last participant: without this,
// whoever remains (e.g. the customer, after the agent hangs up) sits alone in the conference
// hearing silence until they give up. Twilio's endConferenceOnExit attribute can't express
// "end when a STAFF leg leaves" without also killing warm transfers (where the original agent
// leaves a caller+target pair behind on purpose), so instead: on any leg's terminal status,
// end the conference iff at most one participant remains.
export async function cleanupLoneConference(
  accountSid: string,
  authToken: string,
  friendlyName: string
): Promise<void> {
  try {
    const conferenceSid = await findConferenceSid(accountSid, authToken, friendlyName);
    if (!conferenceSid) return;
    const participants = await listParticipants(accountSid, authToken, conferenceSid);
    if (participants.length <= 1) {
      await endConference(accountSid, authToken, conferenceSid);
    }
  } catch {
    // Best-effort: an already-ended conference or a transient API error must never
    // break status-callback processing.
  }
}

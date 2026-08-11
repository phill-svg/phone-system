function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${btoa(`${accountSid}:${authToken}`)}`;
}

export async function findConferenceSid(accountSid: string, authToken: string, friendlyName: string): Promise<string | null> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences.json?FriendlyName=${encodeURIComponent(friendlyName)}`,
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
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants.json`,
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
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
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
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
    { method: "DELETE", headers: { Authorization: authHeader(accountSid, authToken) } }
  );
  if (!res.ok && res.status !== 204) throw new Error(`Twilio remove-participant failed: ${res.status}`);
}

import { getCallDetail } from "../db/calls";

type RecordingEnv = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string };

// The business number and all its recordings are homed in Twilio's au1 (Australia) region;
// recording media is only retrievable from the regional endpoint with au1-region credentials.
// Mirrors TWILIO_API_BASE in src/twilio/restClient.ts.
const TWILIO_API_BASE = "https://api.sydney.au1.twilio.com";

// Authenticated proxy for a call's Twilio recording. The stored recording URL points at Twilio's
// API, which requires Basic auth the browser can't present -- so staff would otherwise hit a
// credential prompt. This route fetches the .mp3 server-side (account creds) and streams it back
// behind the normal staff session, so recordings play inline from the call log. Range requests are
// passed through so the <audio> element can seek.
export async function handleGetRecording(
  env: RecordingEnv,
  db: D1Database,
  callId: string,
  request: Request,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const detail = await getCallDetail(db, callId);
  const recordingSid = detail?.call.recording_sid;
  if (!recordingSid) return new Response("no recording", { status: 404 });

  const mediaUrl = `${TWILIO_API_BASE}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const range = request.headers.get("Range");
  const twilioRes = await fetchImpl(mediaUrl, {
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
      ...(range ? { Range: range } : {}),
    },
  });
  // 200 (full) and 206 (partial, for a Range request) are both success; anything else means the
  // recording isn't retrievable (still processing, deleted, or an auth problem) -- surface a 502.
  if (twilioRes.status !== 200 && twilioRes.status !== 206) {
    return new Response("recording unavailable", { status: 502 });
  }

  const headers = new Headers();
  headers.set("Content-Type", twilioRes.headers.get("Content-Type") ?? "audio/mpeg");
  const contentLength = twilioRes.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const contentRange = twilioRes.headers.get("Content-Range");
  if (contentRange) headers.set("Content-Range", contentRange);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(twilioRes.body, { status: twilioRes.status, headers });
}

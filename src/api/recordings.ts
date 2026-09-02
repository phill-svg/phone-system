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
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("Accept-Ranges", "bytes");

  // Upstream honoured the Range: pass the partial response straight through.
  if (twilioRes.status === 206) {
    const contentRange = twilioRes.headers.get("Content-Range");
    if (contentRange) headers.set("Content-Range", contentRange);
    const upstreamLength = twilioRes.headers.get("Content-Length");
    if (upstreamLength) headers.set("Content-Length", upstreamLength);
    return new Response(twilioRes.body, { status: 206, headers });
  }

  // Upstream returned the whole object. Twilio transcodes the .mp3 on the fly and may answer with
  // no Content-Length, and it ignores Range entirely -- both of which break playback downstream:
  // without a length <audio> reports a non-finite duration (rendered as 0:00) and iOS frequently
  // refuses to play at all, and answering a Range request with a 200 full body while advertising
  // Accept-Ranges leaves the client believing it received partial content. Buffering the body lets
  // us always send an accurate Content-Length and satisfy Range ourselves. Recordings are short
  // (a long call is a few MB), so this fits comfortably in a Worker.
  const body = await twilioRes.arrayBuffer();
  const total = body.byteLength;
  const wanted = range ? parseByteRange(range, total) : null;

  if (wanted) {
    const slice = body.slice(wanted.start, wanted.end + 1);
    headers.set("Content-Range", `bytes ${wanted.start}-${wanted.end}/${total}`);
    headers.set("Content-Length", String(slice.byteLength));
    return new Response(slice, { status: 206, headers });
  }

  headers.set("Content-Length", String(total));
  return new Response(body, { status: 200, headers });
}

// Minimal single-range parser for "bytes=start-end", "bytes=start-" and "bytes=-suffixLength".
// Returns null for a syntactically odd or unsatisfiable range, in which case the caller serves the
// full body as a 200 -- which is a valid response to a Range request.
function parseByteRange(header: string, total: number): { start: number; end: number } | null {
  if (total === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;

  let start: number;
  let end: number;
  if (rawStart === "") {
    if (rawEnd === "") return null;
    const suffix = Number(rawEnd);
    if (suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

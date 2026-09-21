import { getMessageMedia } from "../db/messageMedia";
import { globalAuthHeader } from "../twilio/conferenceClient";

type MediaEnv = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
};

// Twilio's own media host. Anything else in the stored url is refused rather than fetched with the
// account's credentials attached: the url comes from a webhook body, and "follow a URL from a
// request and send credentials with it" is the shape of a credential-leak bug. The same check
// guards the transcript sweep's pagination.
function isTwilioMediaUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "api.twilio.com" || hostname.endsWith(".twilio.com"));
  } catch {
    return false;
  }
}

// An authenticated proxy for one attachment on a message -- a customer's photo.
//
// Twilio's media URL needs the account's credentials, which a browser or the app cannot present, so
// without this staff would get a credential prompt instead of a picture. Same shape as the call
// recording proxy next door.
//
// Credentials via `globalAuthHeader`: messaging on this account runs through US1 (the AU1 token
// 401s against it), which is also where message media is served from -- unlike call recordings,
// which are au1 and use the au1 token.
export async function handleGetMessageMedia(
  env: MediaEnv,
  db: D1Database,
  messageId: string,
  idx: number,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (!Number.isInteger(idx) || idx < 0) return new Response("not found", { status: 404 });
  const media = await getMessageMedia(db, messageId, idx);
  if (!media) return new Response("not found", { status: 404 });
  if (!isTwilioMediaUrl(media.url)) return new Response("not found", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetchImpl(media.url, { headers: { Authorization: globalAuthHeader(env) } });
  } catch {
    return new Response("media unavailable", { status: 502 });
  }
  if (!upstream.ok) {
    // 404 from Twilio means the media has aged out of their store -- we keep the url, not the
    // bytes, so that is a real and permanent answer rather than a transient failure.
    console.log("MESSAGE_MEDIA_FETCH_FAILED", JSON.stringify({ messageId, idx, status: upstream.status }));
    return new Response(upstream.status === 404 ? "media expired" : "media unavailable", {
      status: upstream.status === 404 ? 404 : 502,
    });
  }

  const headers = new Headers();
  // The type WE recorded from the webhook, not the one the upstream response claims, so a client
  // renders what the row says it is.
  headers.set("Content-Type", media.content_type);
  // Private: this is a customer's photo behind a staff session, and it must never land in a shared
  // cache. Immutable within the window because the bytes at a Twilio media URL never change.
  headers.set("Cache-Control", "private, max-age=3600");
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}

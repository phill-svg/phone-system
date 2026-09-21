import { getMessageMedia } from "../db/messageMedia";
import { globalAuthHeader } from "../twilio/conferenceClient";

type MediaEnv = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
};

// The types this route will serve as themselves. Everything else is handed back as an opaque
// download, because the browser must never be invited to interpret a file a stranger sent.
//
// NOTE what is missing: `image/svg+xml`. An SVG is an image to a person and a document that can
// run script to a browser, so serving one inline from our own origin is stored XSS with a staff
// session attached. Twilio reports the type from the file itself, so this is attacker-chosen.
const SERVEABLE_INLINE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

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
  // The type is ALLOWLISTED, not echoed. `content_type` comes from a webhook describing a file a
  // stranger sent us, and this route serves it from our own origin -- where the web thread links it
  // in a tab. `text/html` or `image/svg+xml` served that way is script running on tcbvoip.app with
  // the staff session, from a message anyone can send. SVG is excluded deliberately: it is an image
  // to a person and a script host to a browser.
  //
  // Anything not on the list is still served -- the attachment is real and staff should get it --
  // but as an opaque download rather than something the browser will interpret.
  const safe = SERVEABLE_INLINE.has(media.content_type) ? media.content_type : "application/octet-stream";
  headers.set("Content-Type", safe);
  // Belt and braces: without this a browser may sniff the bytes and decide for itself, which
  // defeats the allowlist above.
  headers.set("X-Content-Type-Options", "nosniff");
  // Images and PDFs display; everything else downloads instead of rendering.
  headers.set("Content-Disposition", safe === "application/octet-stream" ? "attachment" : "inline");
  // Private: this is a customer's photo behind a staff session, and it must never land in a shared
  // cache. Immutable within the window because the bytes at a Twilio media URL never change.
  headers.set("Cache-Control", "private, max-age=3600");
  const length = upstream.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}

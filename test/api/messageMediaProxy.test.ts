import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetMessageMedia } from "../../src/api/messageMediaProxy";
import { insertMessageMedia } from "../../src/db/messageMedia";

// A customer's photo, streamed through our own auth. Twilio's media URL needs the account
// credentials, which a browser and the app cannot present -- so without this route staff get a
// credential prompt instead of a picture.

const ENV = {
  TWILIO_ACCOUNT_SID: "ACxxx",
  TWILIO_AUTH_TOKEN: "au1tok",
  TWILIO_US1_API_KEY_SID: "SKus1",
  TWILIO_US1_API_KEY_SECRET: "shh",
};

async function seed(url: string, contentType = "image/jpeg") {
  await env.DB.prepare("DELETE FROM message_media").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare(
    "INSERT INTO messages (id, direction, peer_number, our_number, body, status, read, created_at) VALUES ('SM1', 'inbound', '+61400000000', '+61485034869', '', 'received', 0, 1)"
  ).run();
  await insertMessageMedia(env.DB, "SM1", [{ idx: 0, content_type: contentType, url }]);
}

describe("handleGetMessageMedia", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("streams the attachment back with the type we recorded", async () => {
    await seed("https://api.twilio.com/media/ME1");
    const fetchImpl = vi.fn(async () => new Response("jpegbytes", { status: 200, headers: { "Content-Length": "9" } }));

    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, fetchImpl as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    // Never a shared cache: this is a customer's photo behind a staff session.
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(await res.text()).toBe("jpegbytes");
  });

  // Messaging on this account runs through US1 -- the AU1 token 401s against it. Call recordings
  // are the opposite (au1), which is exactly why this is asserted rather than assumed.
  it("authenticates with the US1 key, not the AU1 token", async () => {
    await seed("https://api.twilio.com/media/ME1");
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));

    await handleGetMessageMedia(ENV, env.DB, "SM1", 0, fetchImpl as never);

    const headers = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers.Authorization).toBe(`Basic ${btoa("SKus1:shh")}`);
  });

  // The url comes out of a webhook body. Fetching an arbitrary one WITH the account's credentials
  // attached is the shape of a credential-leak bug, so anything off Twilio's host is refused
  // without a request being made at all.
  it("refuses to send credentials to a url that is not Twilio's", async () => {
    await seed("https://evil.example.com/steal");
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));

    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, fetchImpl as never);

    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses plain http, which would put the credentials on the wire", async () => {
    await seed("http://api.twilio.com/media/ME1");
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));
    expect((await handleGetMessageMedia(ENV, env.DB, "SM1", 0, fetchImpl as never)).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("404s an attachment that does not exist", async () => {
    await seed("https://api.twilio.com/media/ME1");
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));
    expect((await handleGetMessageMedia(ENV, env.DB, "SM1", 9, fetchImpl as never)).status).toBe(404);
    expect((await handleGetMessageMedia(ENV, env.DB, "nope", 0, fetchImpl as never)).status).toBe(404);
    expect((await handleGetMessageMedia(ENV, env.DB, "SM1", -1, fetchImpl as never)).status).toBe(404);
  });

  // We store the url, not the bytes, so Twilio ageing the media out is a real and permanent answer
  // -- distinct from a transient upstream failure, which is a 502 the client may retry.
  it("distinguishes media that has expired from Twilio being unavailable", async () => {
    await seed("https://api.twilio.com/media/ME1");
    const gone = vi.fn(async () => new Response("", { status: 404 }));
    expect((await handleGetMessageMedia(ENV, env.DB, "SM1", 0, gone as never)).status).toBe(404);

    const broken = vi.fn(async () => new Response("", { status: 500 }));
    expect((await handleGetMessageMedia(ENV, env.DB, "SM1", 0, broken as never)).status).toBe(502);
  });

  it("answers 502 rather than throwing when Twilio cannot be reached", async () => {
    await seed("https://api.twilio.com/media/ME1");
    const threw = vi.fn(async () => {
      throw new Error("network down");
    });
    expect((await handleGetMessageMedia(ENV, env.DB, "SM1", 0, threw as never)).status).toBe(502);
  });
});

// The content type describes a file a STRANGER sent, and this route serves it from our own origin,
// where the web thread links it in a tab. Echoing it back would be stored XSS on tcbvoip.app with a
// staff session attached, triggerable by anyone who can send the business a message.
describe("what the proxy is willing to serve as itself", () => {
  beforeEach(() => vi.unstubAllGlobals());
  const ok = () => vi.fn(async () => new Response("bytes", { status: 200 }));

  it("serves an ordinary photo as itself, inline", async () => {
    await seed("https://api.twilio.com/media/ME1", "image/jpeg");
    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, ok() as never);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });

  // The attack: a message carrying text/html, opened from the thread, runs on our origin.
  it("refuses to serve HTML as HTML", async () => {
    await seed("https://api.twilio.com/media/ME1", "text/html");
    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, ok() as never);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });

  // An SVG is an image to a person and a script host to a browser. It is excluded on purpose, and
  // both clients refuse to inline it too.
  it("refuses to serve an SVG as an image", async () => {
    await seed("https://api.twilio.com/media/ME1", "image/svg+xml");
    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, ok() as never);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });

  // Without this a browser sniffs the bytes and decides for itself, which defeats the allowlist.
  it("tells the browser not to sniff", async () => {
    await seed("https://api.twilio.com/media/ME1", "image/png");
    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, ok() as never);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  // The attachment is real and staff should still get it -- as a download, not as something the
  // browser will interpret.
  it("still delivers a type it will not inline", async () => {
    await seed("https://api.twilio.com/media/ME1", "audio/amr");
    const res = await handleGetMessageMedia(ENV, env.DB, "SM1", 0, ok() as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
  });
});

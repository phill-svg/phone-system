import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleGetRecording, handleRecoverRecording } from "../../src/api/recordings";

const testEnv = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok-secret" };

async function insertCall(id: string, recordingSid: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours, status, direction, recording_sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61866108941", Date.now(), 0, "completed", "inbound", recordingSid)
    .run();
}

describe("handleGetRecording", () => {
  it("streams the Twilio recording mp3 from the au1 host with Basic auth", async () => {
    await insertCall("CA_rec", "RE123");

    let capturedUrl = "";
    let capturedAuth = "";
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response("MP3BYTES", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }) as unknown as typeof fetch;

    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_rec",
      new Request("https://x/api/calls/CA_rec/recording"),
      fakeFetch
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(capturedUrl).toBe("https://api.sydney.au1.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE123.mp3");
    expect(capturedAuth).toBe(`Basic ${btoa("ACtest:tok-secret")}`);
    expect(await res.text()).toBe("MP3BYTES");
  });

  it("passes a Range header through and returns 206", async () => {
    await insertCall("CA_range", "RE456");

    let capturedRange: string | undefined;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedRange = (init?.headers as Record<string, string>)?.Range;
      return new Response("PARTIAL", {
        status: 206,
        headers: { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-3/8" },
      });
    }) as unknown as typeof fetch;

    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_range",
      new Request("https://x/api/calls/CA_range/recording", { headers: { Range: "bytes=0-3" } }),
      fakeFetch
    );

    expect(capturedRange).toBe("bytes=0-3");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-3/8");
  });

  // Twilio's .mp3 endpoint transcodes on the fly and can answer without a Content-Length. Passing
  // that straight through leaves <audio> with a non-finite duration (renders 0:00) and, on iOS,
  // often refuses to play at all -- so the proxy must always supply one.
  it("always sets Content-Length, even when Twilio omits it", async () => {
    await insertCall("CA_nolen", "RE_nolen");
    const fakeFetch = (async () =>
      new Response("MP3BYTES", { status: 200, headers: { "Content-Type": "audio/mpeg" } })) as unknown as typeof fetch;

    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_nolen",
      new Request("https://x/api/calls/CA_nolen/recording"),
      fakeFetch
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("8");
    expect(await res.text()).toBe("MP3BYTES");
  });

  // We advertise Accept-Ranges: bytes unconditionally, so we have to honour a Range even when the
  // upstream ignores it and hands back the whole object -- otherwise the client is told it got a
  // partial response and gets the full body, which breaks seeking and playback.
  it("satisfies a Range itself when Twilio ignores it and returns 200", async () => {
    await insertCall("CA_ignored", "RE_ignored");
    const fakeFetch = (async () =>
      new Response("MP3BYTES", { status: 200, headers: { "Content-Type": "audio/mpeg" } })) as unknown as typeof fetch;

    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_ignored",
      new Request("https://x/api/calls/CA_ignored/recording", { headers: { Range: "bytes=0-3" } }),
      fakeFetch
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-3/8");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await res.text()).toBe("MP3B");
  });

  it("404s when the call has no recording", async () => {
    await insertCall("CA_norec", null);
    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_norec",
      new Request("https://x/"),
      (async () => new Response("")) as unknown as typeof fetch
    );
    expect(res.status).toBe(404);
  });

  it("404s when the call does not exist", async () => {
    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_missing",
      new Request("https://x/"),
      (async () => new Response("")) as unknown as typeof fetch
    );
    expect(res.status).toBe(404);
  });

  it("502s when Twilio returns an error status", async () => {
    await insertCall("CA_err", "RE789");
    const res = await handleGetRecording(
      testEnv,
      env.DB,
      "CA_err",
      new Request("https://x/"),
      (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    );
    expect(res.status).toBe(502);
  });
});

describe("handleRecoverRecording", () => {
  it("asks Twilio by CallSid and backfills the longest recording found", async () => {
    await insertCall("CA_lost", null);
    let capturedUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ recordings: [{ sid: "REshort", duration: "5" }, { sid: "RElong", duration: "141" }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const res = await handleRecoverRecording(testEnv, env.DB, "CA_lost", fakeFetch);
    const body = (await res.json()) as { recovered: boolean; recordingSid: string };
    expect(body).toMatchObject({ recovered: true, recordingSid: "RElong" });
    expect(capturedUrl).toBe("https://api.sydney.au1.twilio.com/2010-04-01/Accounts/ACtest/Recordings.json?CallSid=CA_lost");

    const row = await env.DB.prepare("SELECT recording_url, recording_sid, recording_duration FROM calls WHERE id = ?")
      .bind("CA_lost")
      .first<{ recording_url: string; recording_sid: string; recording_duration: number }>();
    expect(row?.recording_sid).toBe("RElong");
    expect(row?.recording_url).toBe("https://api.sydney.au1.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RElong");
    expect(row?.recording_duration).toBe(141);
  });

  it("reports recovered: false when Twilio genuinely has nothing for this call", async () => {
    await insertCall("CA_gone", null);
    const res = await handleRecoverRecording(
      testEnv,
      env.DB,
      "CA_gone",
      (async () => new Response(JSON.stringify({ recordings: [] }), { status: 200 })) as unknown as typeof fetch
    );
    const body = (await res.json()) as { recovered: boolean };
    expect(body.recovered).toBe(false);

    const row = await env.DB.prepare("SELECT recording_sid FROM calls WHERE id = ?").bind("CA_gone").first<{ recording_sid: string | null }>();
    expect(row?.recording_sid).toBeNull();
  });

  it("502s when Twilio itself errors, without touching the row", async () => {
    await insertCall("CA_twilio_err", null);
    const res = await handleRecoverRecording(
      testEnv,
      env.DB,
      "CA_twilio_err",
      (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    );
    expect(res.status).toBe(502);
  });
});

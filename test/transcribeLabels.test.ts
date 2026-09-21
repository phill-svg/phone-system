import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillLabels, transcribeRecording, MAX_LABEL_ATTEMPTS } from "../src/transcribe";

// The review round on the labelling: what happens when it does NOT produce a transcript. Each of
// these was a way to lose the labels silently, and they are not interchangeable -- collapsing them
// into one marker is the defect the deleted Twilio sweep existed to prevent.

// A two-channel PCM WAV, built the way Twilio serves one.
function stereoWav(frames = 4): Uint8Array {
  const out = new Uint8Array(44 + frames * 4);
  const view = new DataView(out.buffer);
  const ascii = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 4, true);
  return out;
}

type WhisperOut = { text: string; segments?: { start: number; text: string }[] };

function aiEnv(results: WhisperOut[]) {
  const queue = [...results];
  const run = vi.fn(async () => queue.shift() ?? { text: "" });
  return { env: { DB: env.DB, AI: { run }, TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t" }, run };
}

async function insertCall(id: string, extra: { status?: string; transcript?: string; polls?: number } = {}) {
  await env.DB.prepare(
    `INSERT INTO calls (id, caller_number, called_number, started_at, status, recording_url,
                        call_transcript, intelligence_status, intelligence_polls, transcript_staff_channel)
     VALUES (?, '+61400000000', '+61261059771', ?, 'completed', 'https://api.twilio.com/rec', ?, ?, ?, 2)`
  )
    .bind(id, Date.now(), extra.transcript ?? null, extra.status ?? null, extra.polls ?? 0)
    .run();
}

const label = (e: unknown, id: string, staffChannel: 1 | 2 = 2) =>
  transcribeRecording(e as never, id, "https://api.twilio.com/rec", {
    column: "call_transcript",
    dualChannel: true,
    staffChannel,
  });

describe("labelling failures", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls WHERE id LIKE 'CA-lab%'").run();
    vi.unstubAllGlobals();
  });

  // A 5xx from Twilio's media host says nothing about the recording. The call already has a plain
  // transcript by the time this runs, which makes it invisible to `backfillTranscripts` -- so a
  // terminal marker here costs the labels permanently for one blip.
  it("marks a transient media failure for retry rather than giving up on it", async () => {
    await insertCall("CA-lab-502");
    const { env: e } = aiEnv([{ text: "plain" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("RequestedChannels=2")
          ? new Response("upstream", { status: 502 })
          : new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      )
    );

    await label(e, "CA-lab-502");

    const row = await env.DB.prepare("SELECT call_transcript, intelligence_status FROM calls WHERE id = 'CA-lab-502'")
      .first<{ call_transcript: string | null; intelligence_status: string | null }>();
    expect(row?.intelligence_status).toBe("label_retry");
    expect(row?.call_transcript).toBe("plain");
  });

  // 4xx is Twilio saying this recording has no second channel -- a mono recording, or an older one.
  // Asking again cannot change that, and it is not a fault: no marker, or Health Checks goes red
  // over something working exactly as designed.
  it("treats a 4xx as terminal and unremarkable, not retryable", async () => {
    await insertCall("CA-lab-400");
    const { env: e } = aiEnv([{ text: "plain" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("RequestedChannels=2")
          ? new Response("no dual channel", { status: 400 })
          : new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      )
    );

    await label(e, "CA-lab-400");

    const row = await env.DB.prepare("SELECT intelligence_status, call_transcript FROM calls WHERE id = 'CA-lab-400'")
      .first<{ intelligence_status: string | null; call_transcript: string | null }>();
    expect(row?.intelligence_status).toBeNull();
    expect(row?.call_transcript).toBe("plain");
  });

  // A deliberate size refusal is not a fault and must not reach a marker at all -- one that is
  // always set is one you learn to ignore. The check is on the HEADER, because reading the body
  // first is the allocation the cap exists to prevent.
  it("refuses an over-long recording on its content-length, without marking it", async () => {
    await insertCall("CA-lab-long");
    const { env: e } = aiEnv([{ text: "plain" }]);
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).includes("RequestedChannels=2")
        ? new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-length": String(200 * 1024 * 1024) },
          })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await label(e, "CA-lab-long");

    const row = await env.DB.prepare("SELECT intelligence_status, call_transcript FROM calls WHERE id = 'CA-lab-long'")
      .first<{ intelligence_status: string | null; call_transcript: string | null }>();
    expect(row?.intelligence_status).toBeNull();
    expect(row?.call_transcript).toBe("plain");
  });

  // Whisper invents words on a silent channel. The merge reads SEGMENTS whenever both channels have
  // timings, so a filter that only cleans the joined text puts an invented sentence into the
  // transcript under a named speaker -- worse than no label at all.
  it("keeps a hallucinated channel out of the labelled transcript", async () => {
    await insertCall("CA-lab-halluc");
    const { env: e } = aiEnv([
      { text: "I have a rat problem.", segments: [{ start: 1, text: "I have a rat problem." }] },
      { text: "Thanks for watching", segments: [{ start: 0, text: "Thanks for watching" }] },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stereoWav(), { status: 200 })));

    await label(e, "CA-lab-halluc");

    const row = await env.DB.prepare("SELECT call_transcript FROM calls WHERE id = 'CA-lab-halluc'")
      .first<{ call_transcript: string }>();
    expect(row?.call_transcript).toBe("Customer: I have a rat problem.");
  });

  // Twilio redelivers callbacks. Without the guard the same recording is fetched again and two more
  // inferences run to write the same text.
  it("does not relabel a call that is already labelled", async () => {
    await insertCall("CA-lab-again", { status: "completed", transcript: "Customer: first." });
    const { env: e } = aiEnv([
      { text: "second", segments: [{ start: 0, text: "second" }] },
      { text: "third", segments: [{ start: 1, text: "third" }] },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stereoWav(), { status: 200 })));

    await label(e, "CA-lab-again");

    const row = await env.DB.prepare("SELECT call_transcript FROM calls WHERE id = 'CA-lab-again'")
      .first<{ call_transcript: string }>();
    expect(row?.call_transcript).toBe("Customer: first.");
  });
});

describe("backfillLabels", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls WHERE id LIKE 'CA-lab%'").run();
    vi.unstubAllGlobals();
  });

  // The whole point of the sweep: these rows already have a plain transcript, so
  // `backfillTranscripts` will never look at them again. This is the only thing that can still
  // recover the labels after a transient failure.
  it("labels a call whose earlier attempt hit a transient failure", async () => {
    await insertCall("CA-lab-retry", { status: "label_retry", transcript: "plain" });
    const { env: e } = aiEnv([
      { text: "Hello?", segments: [{ start: 0, text: "Hello?" }] },
      { text: "TCB pest control.", segments: [{ start: 1, text: "TCB pest control." }] },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stereoWav(), { status: 200 })));

    await backfillLabels(e as never);

    const row = await env.DB.prepare("SELECT call_transcript, intelligence_status FROM calls WHERE id = 'CA-lab-retry'")
      .first<{ call_transcript: string; intelligence_status: string }>();
    expect(row?.call_transcript).toBe("Customer: Hello?\n\nStaff: TCB pest control.");
    expect(row?.intelligence_status).toBe("completed");
  });

  // Counted BEFORE the work, or a recording that fails the same way every time is re-fetched every
  // five minutes forever -- not everything that looks transient is.
  it("counts the attempt, and stops once the cap is reached", async () => {
    await insertCall("CA-lab-capped", { status: "label_retry", transcript: "plain", polls: MAX_LABEL_ATTEMPTS });
    const { env: e } = aiEnv([]);
    const fetchMock = vi.fn(async () => new Response("", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await backfillLabels(e as never)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await insertCall("CA-lab-once", { status: "label_retry", transcript: "plain" });
    await backfillLabels(e as never);
    const row = await env.DB.prepare("SELECT intelligence_polls, intelligence_status FROM calls WHERE id = 'CA-lab-once'")
      .first<{ intelligence_polls: number; intelligence_status: string }>();
    expect(row?.intelligence_polls).toBe(1);
    // Still retryable rather than given up on: the cap, not one failure, is what ends this.
    expect(row?.intelligence_status).toBe("label_retry");
  });

  // The LAST attempt has to be terminal. A row left on `label_retry` once it falls out of the
  // sweep's query counts towards nothing on Health Checks, so a call that will never be labelled
  // reads as "waiting on another attempt" forever -- and a media-host outage of more than fifteen
  // minutes puts every call in the window there (limit 2, three attempts, one tick per five).
  it("gives up terminally on the final attempt instead of sitting on label_retry", async () => {
    await insertCall("CA-lab-last", { status: "label_retry", transcript: "plain", polls: MAX_LABEL_ATTEMPTS - 1 });
    const { env: e } = aiEnv([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));

    await backfillLabels(e as never);

    const row = await env.DB.prepare("SELECT intelligence_status FROM calls WHERE id = 'CA-lab-last'")
      .first<{ intelligence_status: string }>();
    expect(row?.intelligence_status).toBe("unlabelled");
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillTranscripts, transcribeCallRecording, transcribeRecording, MAX_TRANSCRIBE_ATTEMPTS } from "../src/transcribe";

// backfillTranscripts fetches the recording from Twilio and runs Workers AI. Both are stubbed:
// `fetch` returns a tiny mp3 body, and a fake AI binding returns whatever text the test wants.
function makeEnv(text: string | null) {
  const run = vi.fn(async () => ({ text: text ?? "" }));
  return {
    env: {
      DB: env.DB,
      AI: { run },
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "token",
    },
    run,
  };
}

async function insertCall(opts: {
  id: string;
  mailbox?: string | null;
  recordingUrl?: string | null;
  transcription?: string | null;
  callTranscript?: string | null;
  attempts?: number;
}) {
  await env.DB.prepare(
    `INSERT INTO calls (id, caller_number, called_number, started_at, status, recording_url,
                        mailbox_label, transcription, call_transcript, transcribe_attempts)
     VALUES (?, '+61400000000', '+61866108941', ?, 'completed', ?, ?, ?, ?, ?)`
  )
    .bind(
      opts.id,
      Date.now(),
      opts.recordingUrl ?? null,
      opts.mailbox ?? null,
      opts.transcription ?? null,
      opts.callTranscript ?? null,
      opts.attempts ?? 0
    )
    .run();
}

async function readCall(id: string) {
  return env.DB.prepare(
    "SELECT transcription, call_transcript, transcribe_attempts FROM calls WHERE id = ?"
  )
    .bind(id)
    .first<{ transcription: string | null; call_transcript: string | null; transcribe_attempts: number }>();
}

describe("backfillTranscripts", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    );
  });

  it("transcribes a voicemail into `transcription`, not `call_transcript`", async () => {
    await insertCall({ id: "CA_vm", mailbox: "after hours", recordingUrl: "https://api.twilio.com/r/RE1" });
    const { env: e } = makeEnv("Hi, please call me back about the wasps.");

    expect(await backfillTranscripts(e, 5)).toBe(1);

    const row = await readCall("CA_vm");
    expect(row?.transcription).toBe("Hi, please call me back about the wasps.");
    expect(row?.call_transcript).toBeNull();
  });

  it("transcribes an answered call into `call_transcript`", async () => {
    await insertCall({ id: "CA_ans", recordingUrl: "https://api.twilio.com/r/RE2" });
    const { env: e } = makeEnv("Booking confirmed for Tuesday.");

    await backfillTranscripts(e, 5);

    const row = await readCall("CA_ans");
    expect(row?.call_transcript).toBe("Booking confirmed for Tuesday.");
    expect(row?.transcription).toBeNull();
  });

  it("skips recordings that already have the transcript their column needs", async () => {
    await insertCall({ id: "CA_done_vm", mailbox: "5", recordingUrl: "https://x/RE3", transcription: "already here" });
    await insertCall({ id: "CA_done_call", recordingUrl: "https://x/RE4", callTranscript: "already here" });
    const { env: e, run } = makeEnv("should not be used");

    expect(await backfillTranscripts(e, 5)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips calls with no recording", async () => {
    await insertCall({ id: "CA_norec", recordingUrl: null });
    const { env: e, run } = makeEnv("nope");

    expect(await backfillTranscripts(e, 5)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  // The important one: a silent voicemail transcribes to "" and writes nothing, so without the
  // attempt counter the cron would re-fetch and re-transcribe it on every tick, forever.
  it("counts an attempt even when the transcript comes back empty, and gives up after the cap", async () => {
    await insertCall({ id: "CA_silent", mailbox: "5", recordingUrl: "https://x/RE5" });
    const { env: e, run } = makeEnv("");

    for (let i = 0; i < MAX_TRANSCRIBE_ATTEMPTS; i++) await backfillTranscripts(e, 5);

    const row = await readCall("CA_silent");
    expect(row?.transcription).toBeNull();
    expect(row?.transcribe_attempts).toBe(MAX_TRANSCRIBE_ATTEMPTS);
    expect(run).toHaveBeenCalledTimes(MAX_TRANSCRIBE_ATTEMPTS);

    // Capped: further sweeps must not pick it up again.
    run.mockClear();
    expect(await backfillTranscripts(e, 5)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("honours the per-tick limit so one cron invocation stays bounded", async () => {
    for (let i = 0; i < 5; i++) {
      await insertCall({ id: `CA_many_${i}`, mailbox: "5", recordingUrl: `https://x/RE_${i}` });
    }
    const { env: e } = makeEnv("a message");

    expect(await backfillTranscripts(e, 2)).toBe(2);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM calls WHERE transcription IS NULL AND transcribe_attempts = 0"
    ).first<{ n: number }>();
    expect(remaining?.n).toBe(3);
  });
});

describe("Whisper never overwrites a speaker-labelled transcript", () => {
  // backfillTranscripts and the Twilio sweep run in the SAME cron tick. Backfill can select a row
  // whose transcript is still NULL, spend 10-30s in Workers AI, and land after the sweep has written
  // the labelled text -- destroying it permanently, since the row is by then out of the sweep's
  // query. The guard is on the write, because the gap between read and write is where the race is.
  it("leaves call_transcript alone once intelligence_status is completed", async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status, call_transcript, intelligence_status) VALUES ('CA-race', '+61400000000', '+61261059771', ?, 'completed', 'Customer: hello.', 'completed')"
    )
      .bind(Date.now())
      .run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(8), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const aiEnv = {
      DB: env.DB,
      AI: { run: async () => ({ text: "unlabelled whisper blob" }) },
      TWILIO_ACCOUNT_SID: "AC",
      TWILIO_AUTH_TOKEN: "tok",
    };

    await transcribeCallRecording(aiEnv as never, "CA-race", "https://api.twilio.com/rec", "call_transcript");

    const row = await env.DB.prepare("SELECT call_transcript FROM calls WHERE id = 'CA-race'").first<{
      call_transcript: string;
    }>();
    expect(row?.call_transcript).toBe("Customer: hello.");
    vi.unstubAllGlobals();
  });
});

// ---- Speaker-labelled transcripts (the dual-channel path) ----
//
// Twilio's Conversational Intelligence cannot be used on this account -- it is unsupported in AU1
// and the landline is au1, so every request for an au1 recording came back
// "Resource RE... not found". The labelling is done here instead: split the two-channel recording,
// transcribe each channel, merge. These tests cover the CHOICE between that and the plain
// single-pass transcript, which is where the cost of being wrong is a lost transcript.
describe("transcribeRecording", () => {
  // A two-channel PCM WAV, built the way Twilio serves one.
  function stereoWav(frames = 4): Uint8Array {
    const out = new Uint8Array(44 + frames * 4);
    const view = new DataView(out.buffer);
    const ascii = (o: number, t: string) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
    ascii(0, "RIFF"); view.setUint32(4, out.length - 8, true); ascii(8, "WAVE");
    ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 2, true); view.setUint32(24, 8000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 4, true); view.setUint16(34, 16, true);
    ascii(36, "data"); view.setUint32(40, frames * 4, true);
    return out;
  }

  function dualEnv(results: { text: string; segments?: { start: number; text: string }[] }[], body: Uint8Array | null = stereoWav()) {
    const run = vi.fn(async () => results.shift() ?? { text: "" });
    // Twilio answers 400 to `?RequestedChannels=2` for a recording that has only one channel, while
    // the ordinary media URL still serves fine -- so the stub must distinguish them, or a test of
    // the fallback would "pass" because BOTH fetches failed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const isDual = String(input).includes("RequestedChannels=2");
        if (isDual && !body) return new Response("no dual channel", { status: 400 });
        return new Response(isDual ? body! : new Uint8Array([1, 2, 3]), { status: 200 });
      })
    );
    return { env: { DB: env.DB, AI: { run }, TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "token" }, run };
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls WHERE id LIKE 'CA-dual%'").run();
    vi.unstubAllGlobals();
  });

  it("labels each speaker and marks the call completed", async () => {
    await insertCall({ id: "CA-dual-1", recordingUrl: "https://api.twilio.com/rec" });
    const { env: e, run } = dualEnv([
      { text: "Hello? I have a rat problem.", segments: [{ start: 0, text: "Hello? I have a rat problem." }] },
      { text: "Whereabouts are you?", segments: [{ start: 2, text: "Whereabouts are you?" }] },
    ]);

    await transcribeRecording(e as never, "CA-dual-1", "https://api.twilio.com/rec", {
      column: "call_transcript",
      dualChannel: true,
      staffChannel: 2,
    });

    const row = await env.DB.prepare("SELECT call_transcript, intelligence_status FROM calls WHERE id = 'CA-dual-1'")
      .first<{ call_transcript: string; intelligence_status: string }>();
    expect(row?.call_transcript).toBe("Customer: Hello? I have a rat problem.\n\nStaff: Whereabouts are you?");
    expect(row?.intelligence_status).toBe("completed");
    // Once per channel, and NOT a third time: the plain transcript must not run and overwrite this.
    expect(run).toHaveBeenCalledTimes(2);
  });

  // The whole reason the channel is stored per call: call-via-mobile records on the STAFF member's
  // own mobile leg, so channel 1 is staff there and every other flow has it the other way round.
  // Getting this wrong quotes the customer's words as the staff member's, with nothing to catch it.
  it("honours the staff channel when it is 1", async () => {
    await insertCall({ id: "CA-dual-swap", recordingUrl: "https://api.twilio.com/rec" });
    const { env: e } = dualEnv([
      { text: "TCB pest control.", segments: [{ start: 0, text: "TCB pest control." }] },
      { text: "Hi, I need a quote.", segments: [{ start: 1, text: "Hi, I need a quote." }] },
    ]);

    await transcribeRecording(e as never, "CA-dual-swap", "https://api.twilio.com/rec", {
      column: "call_transcript",
      dualChannel: true,
      staffChannel: 1,
    });

    const row = await env.DB.prepare("SELECT call_transcript FROM calls WHERE id = 'CA-dual-swap'")
      .first<{ call_transcript: string }>();
    expect(row?.call_transcript).toBe("Staff: TCB pest control.\n\nCustomer: Hi, I need a quote.");
  });

  // An unlabelled transcript is worth far more than none. Twilio answers 400 when the recording has
  // only one channel, which is not a fault, so the row is left unmarked.
  it("falls back to the plain transcript when the two-channel file cannot be fetched", async () => {
    await insertCall({ id: "CA-dual-404", recordingUrl: "https://api.twilio.com/rec" });
    const { env: e } = dualEnv([{ text: "both voices together" }], null);

    await transcribeRecording(e as never, "CA-dual-404", "https://api.twilio.com/rec", {
      column: "call_transcript",
      dualChannel: true,
      staffChannel: 2,
    });

    const row = await env.DB.prepare("SELECT call_transcript, intelligence_status FROM calls WHERE id = 'CA-dual-404'")
      .first<{ call_transcript: string | null; intelligence_status: string | null }>();
    expect(row?.call_transcript).toBe("both voices together");
    expect(row?.intelligence_status).toBeNull();
  });

  // Two channels arrived and the audio would not parse. THAT is a fault: the call keeps its plain
  // transcript and the row says so, because silence here is what hid the whole feature being broken
  // for a fortnight. (A call where nobody spoke is a different case and is left unmarked.)
  it("marks a two-channel recording it could not label, and still stores the plain transcript", async () => {
    await insertCall({ id: "CA-dual-empty", recordingUrl: "https://api.twilio.com/rec" });
    const { env: e } = dualEnv([{ text: "plain text" }], new Uint8Array([1, 2, 3, 4]));

    await transcribeRecording(e as never, "CA-dual-empty", "https://api.twilio.com/rec", {
      column: "call_transcript",
      dualChannel: true,
      staffChannel: 2,
    });

    const row = await env.DB.prepare("SELECT call_transcript, intelligence_status FROM calls WHERE id = 'CA-dual-empty'")
      .first<{ call_transcript: string | null; intelligence_status: string | null }>();
    expect(row?.intelligence_status).toBe("unlabelled");
    expect(row?.call_transcript).toBe("plain text");
  });

  // Voicemail is one person talking: labelling it would pay twice to say "Customer:" in front of a
  // message, and it lands in `transcription`, not `call_transcript`.
  it("never labels voicemail", async () => {
    await insertCall({ id: "CA-dual-vm", recordingUrl: "https://api.twilio.com/rec", mailbox: "Voicemail" });
    const { env: e, run } = dualEnv([{ text: "leave a message" }]);

    await transcribeRecording(e as never, "CA-dual-vm", "https://api.twilio.com/rec", {
      column: "transcription",
      dualChannel: true,
      staffChannel: 2,
    });

    expect(run).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare("SELECT transcription FROM calls WHERE id = 'CA-dual-vm'")
      .first<{ transcription: string }>();
    expect(row?.transcription).toBe("leave a message");
  });
});

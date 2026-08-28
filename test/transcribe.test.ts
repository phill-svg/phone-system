import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillTranscripts, MAX_TRANSCRIBE_ATTEMPTS } from "../src/transcribe";

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

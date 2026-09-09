import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPendingTranscripts, MAX_INTELLIGENCE_POLLS } from "../../src/twilio/intelligenceQueue";

const ON = { ...env, TWILIO_INTELLIGENCE_SERVICE_SID: "GA-test" } as never;

async function seed(id: string, opts: { sid?: string | null; status?: string | null } = {}) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, status, call_transcript, intelligence_sid, intelligence_status) VALUES (?, ?, ?, ?, 'completed', 'whisper text', ?, ?)"
  )
    .bind(id, "+61400000000", "+61261059771", Date.now(), opts.sid ?? null, opts.status ?? null)
    .run();
}

async function readCall(id: string) {
  return env.DB.prepare("SELECT call_transcript, intelligence_status FROM calls WHERE id = ?")
    .bind(id)
    .first<{ call_transcript: string | null; intelligence_status: string | null }>();
}

function stub(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: unknown) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const completed = () => new Response(JSON.stringify({ status: "completed" }), { status: 200 });
const sentences = (list: { media_channel: number; transcript: string; sentence_index: number }[]) =>
  new Response(JSON.stringify({ sentences: list }), { status: 200 });

describe("collectPendingTranscripts", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
  });
  afterEach(() => vi.unstubAllGlobals());

  // The whole feature is gated on the secret, including the sweep -- it must not even query.
  it("does nothing at all when no service sid is configured", async () => {
    await seed("CA-off", { sid: "GT1", status: "0" });
    const fetchMock = stub(() => new Response("", { status: 500 }));
    expect(await collectPendingTranscripts(env as never)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the labelled transcript over the Whisper one when Twilio is done", async () => {
    await seed("CA-done", { sid: "GT-done", status: "0" });
    stub((url) =>
      url.includes("/Sentences")
        ? sentences([
            { media_channel: 2, transcript: "Would that be Phil?", sentence_index: 0 },
            { media_channel: 1, transcript: "Yes, speaking.", sentence_index: 1 },
          ])
        : completed()
    );

    expect(await collectPendingTranscripts(ON)).toBe(1);
    const row = await readCall("CA-done");
    expect(row?.call_transcript).toBe("Customer: Would that be Phil?\n\nStaff: Yes, speaking.");
    expect(row?.intelligence_status).toBe("completed");
  });

  // Without dual-channel recording every sentence lands on one channel. A confidently mislabelled
  // transcript is worse than an unlabelled one, so Whisper's text must survive untouched.
  it("keeps the Whisper transcript when the recording was not dual-channel", async () => {
    await seed("CA-mono", { sid: "GT-mono", status: "0" });
    stub((url) =>
      url.includes("/Sentences")
        ? sentences([
            { media_channel: 1, transcript: "Hello.", sentence_index: 0 },
            { media_channel: 1, transcript: "Yes, speaking.", sentence_index: 1 },
          ])
        : completed()
    );

    expect(await collectPendingTranscripts(ON)).toBe(0);
    const row = await readCall("CA-mono");
    expect(row?.call_transcript).toBe("whisper text");
    expect(row?.intelligence_status).toBe("failed");
  });

  it("counts an attempt while the job is still running, and leaves the text alone", async () => {
    await seed("CA-running", { sid: "GT-run", status: "3" });
    stub(() => new Response(JSON.stringify({ status: "in-progress" }), { status: 200 }));

    expect(await collectPendingTranscripts(ON)).toBe(0);
    const row = await readCall("CA-running");
    expect(row?.intelligence_status).toBe("4");
    expect(row?.call_transcript).toBe("whisper text");
  });

  // A job that never finishes must terminate, or the sweep chases it on every tick forever.
  it("gives up on a transcript that never completes", async () => {
    await seed("CA-stuck", { sid: "GT-stuck", status: String(MAX_INTELLIGENCE_POLLS) });
    const fetchMock = stub(() => new Response(JSON.stringify({ status: "queued" }), { status: 200 }));

    await collectPendingTranscripts(ON);
    expect((await readCall("CA-stuck"))?.intelligence_status).toBe("failed");
    // Abandoned without even asking Twilio again.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a failed transcript failed rather than retrying it", async () => {
    await seed("CA-failed", { sid: "GT-failed", status: "0" });
    stub(() => new Response(JSON.stringify({ status: "failed" }), { status: 200 }));

    await collectPendingTranscripts(ON);
    expect((await readCall("CA-failed"))?.intelligence_status).toBe("failed");
  });

  it("ignores calls that never had a transcript requested", async () => {
    await seed("CA-none");
    const fetchMock = stub(() => completed());
    expect(await collectPendingTranscripts(ON)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

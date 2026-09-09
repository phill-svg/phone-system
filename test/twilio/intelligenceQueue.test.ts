import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPendingTranscripts, MAX_INTELLIGENCE_POLLS } from "../../src/twilio/intelligenceQueue";
import { setTranscriptStaffChannel } from "../../src/db/settings";

const ON = { ...env, TWILIO_INTELLIGENCE_SERVICE_SID: "GA-test" } as never;

async function seed(
  id: string,
  opts: { sid?: string | null; status?: string | null; polls?: number } = {}
) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, status, call_transcript, intelligence_sid, intelligence_status, intelligence_polls) VALUES (?, ?, ?, ?, 'completed', 'whisper text', ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61261059771", Date.now(), opts.sid ?? null, opts.status ?? null, opts.polls ?? 0)
    .run();
}

async function readCall(id: string) {
  return env.DB.prepare("SELECT call_transcript, intelligence_status, intelligence_polls FROM calls WHERE id = ?")
    .bind(id)
    .first<{ call_transcript: string | null; intelligence_status: string | null; intelligence_polls: number }>();
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
    await seed("CA-off", { sid: "GT1", status: "pending" });
    const fetchMock = stub(() => new Response("", { status: 500 }));
    expect(await collectPendingTranscripts(env as never)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the labelled transcript over the Whisper one when Twilio is done", async () => {
    await seed("CA-done", { sid: "GT-done", status: "pending" });
    stub((url) =>
      url.includes("/Sentences")
        ? // The caller is redirected into the conference before the staff leg joins, so under the
          // default setting the CUSTOMER is channel 1 and staff are channel 2.
          sentences([
            { media_channel: 1, transcript: "Would that be Phil?", sentence_index: 0 },
            { media_channel: 2, transcript: "Yes, speaking.", sentence_index: 1 },
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
    await seed("CA-mono", { sid: "GT-mono", status: "pending" });
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
    // Its OWN state, not a generic failure: this is the one that says the Console's dual-channel
    // switch is off, which is fixable and affects every call.
    expect(row?.intelligence_status).toBe("single_channel");
  });

  it("counts an attempt while the job is still running, and leaves the text alone", async () => {
    await seed("CA-running", { sid: "GT-run", status: "pending", polls: 3 });
    stub(() => new Response(JSON.stringify({ status: "in-progress" }), { status: 200 }));

    expect(await collectPendingTranscripts(ON)).toBe(0);
    const row = await readCall("CA-running");
    expect(row?.intelligence_status).toBe("pending");
    expect(row?.intelligence_polls).toBe(4);
    expect(row?.call_transcript).toBe("whisper text");
  });

  // A job that never finishes must terminate, or the sweep chases it on every tick forever.
  it("gives up on a transcript that never completes", async () => {
    await seed("CA-stuck", { sid: "GT-stuck", status: "pending", polls: MAX_INTELLIGENCE_POLLS });
    const fetchMock = stub(() => new Response(JSON.stringify({ status: "queued" }), { status: 200 }));

    await collectPendingTranscripts(ON);
    expect((await readCall("CA-stuck"))?.intelligence_status).toBe("abandoned");
    // Abandoned without even asking Twilio again.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a failed transcript failed rather than retrying it", async () => {
    await seed("CA-failed", { sid: "GT-failed", status: "pending" });
    stub(() => new Response(JSON.stringify({ status: "failed" }), { status: 200 }));

    await collectPendingTranscripts(ON);
    expect((await readCall("CA-failed"))?.intelligence_status).toBe("failed");
  });

  // Which channel is staff is a race between two Twilio-side conference joins, so it is a setting
  // rather than a constant -- an earlier version hardcoded the wrong one and would have labelled
  // every inbound transcript backwards while presenting it as fact.
  it("honours the configured staff channel", async () => {
    await setTranscriptStaffChannel(env.DB, 1);
    await seed("CA-swap", { sid: "GT-swap", status: "pending" });
    stub((url) =>
      url.includes("/Sentences")
        ? sentences([
            { media_channel: 1, transcript: "Would that be Phil?", sentence_index: 0 },
            { media_channel: 2, transcript: "Yes, speaking.", sentence_index: 1 },
          ])
        : completed()
    );

    await collectPendingTranscripts(ON);
    expect((await readCall("CA-swap"))?.call_transcript).toBe(
      "Staff: Would that be Phil?\n\nCustomer: Yes, speaking."
    );
    await setTranscriptStaffChannel(env.DB, 2);
  });

  // Twilio's sentences are paginated. Storing only the first page would end a long call
  // mid-conversation, mark it completed, and overwrite a COMPLETE Whisper transcript.
  it("follows pagination rather than truncating a long call", async () => {
    await seed("CA-paged", { sid: "GT-paged", status: "pending" });
    stub((url) => {
      if (!url.includes("/Sentences")) return completed();
      if (url.includes("Page=2")) {
        return new Response(
          JSON.stringify({
            sentences: [{ media_channel: 2, transcript: "And the second half.", sentence_index: 1 }],
            meta: { next_page_url: null },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          sentences: [{ media_channel: 1, transcript: "The first half.", sentence_index: 0 }],
          meta: { next_page_url: "https://intelligence.twilio.com/v2/Transcripts/GT-paged/Sentences?Page=2" },
        }),
        { status: 200 }
      );
    });

    await collectPendingTranscripts(ON);
    expect((await readCall("CA-paged"))?.call_transcript).toBe(
      "Customer: The first half.\n\nStaff: And the second half."
    );
  });

  // We re-send the Twilio account token with each page, so the next-page URL must stay on Twilio's
  // own origin. Following one off-origin would hand the account credentials to whoever set it.
  it("does not follow a next-page URL to another origin", async () => {
    await seed("CA-offsite", { sid: "GT-offsite", status: "pending" });
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (!url.includes("/Sentences")) return completed();
      return new Response(
        JSON.stringify({
          sentences: [
            { media_channel: 1, transcript: "Hello.", sentence_index: 0 },
            { media_channel: 2, transcript: "Speaking.", sentence_index: 1 },
          ],
          meta: { next_page_url: "https://evil.example.com/v2/Transcripts/GT-offsite/Sentences?Page=2" },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await collectPendingTranscripts(ON);

    expect(seen.some((u) => u.includes("evil.example.com"))).toBe(false);
    // The pages we DID get are still stored -- refusing to follow is not the same as discarding.
    expect((await readCall("CA-offsite"))?.call_transcript).toBe("Customer: Hello.\n\nStaff: Speaking.");
  });

  it("ignores calls that never had a transcript requested", async () => {
    await seed("CA-none");
    const fetchMock = stub(() => completed());
    expect(await collectPendingTranscripts(ON)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

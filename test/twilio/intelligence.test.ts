import { describe, expect, it, vi } from "vitest";
import { formatLabelledTranscript, intelligenceEnabled, requestTranscript, type Sentence } from "../../src/twilio/intelligence";

const s = (channel: number, text: string, i: number): Sentence => ({
  media_channel: channel,
  transcript: text,
  sentence_index: i,
});

describe("intelligenceEnabled", () => {
  // Everything is gated on this: an unset secret must leave the existing Whisper behaviour exactly
  // as it was rather than half-enabling a paid feature.
  it("is off until a service sid is configured", () => {
    const base = { TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "tok" };
    expect(intelligenceEnabled(base)).toBe(false);
    expect(intelligenceEnabled({ ...base, TWILIO_INTELLIGENCE_SERVICE_SID: "" })).toBe(false);
    expect(intelligenceEnabled({ ...base, TWILIO_INTELLIGENCE_SERVICE_SID: "GA123" })).toBe(true);
  });
});

describe("requestTranscript auth", () => {
  // intelligence.twilio.com is a GLOBAL (implicitly US1) host. TWILIO_AUTH_TOKEN is this account's
  // AU1 token and 401s there every time -- the exact bug that left every inbound transcript as
  // `request_failed`. Asserting the header VALUE, not just that the call succeeded, is the point:
  // a revert back to TWILIO_AUTH_TOKEN would still return a sid from this mock and pass a looser
  // test, the same way the fallback branch alone would.
  const env = {
    TWILIO_ACCOUNT_SID: "ACxxx",
    TWILIO_AUTH_TOKEN: "au1tok",
    TWILIO_US1_API_KEY_SID: "SKus1",
    TWILIO_US1_API_KEY_SECRET: "shh",
    TWILIO_INTELLIGENCE_SERVICE_SID: "GA123",
  };

  it("authenticates with the US1 API key, not the AU1 auth token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: "GT123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestTranscript(env, "RExxx", { staffChannel: 2 });
    expect(result).toEqual({ sid: "GT123", error: null });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("SKus1:shh")}`);
    expect(headers.Authorization).not.toBe(`Basic ${btoa("ACxxx:au1tok")}`);
  });

  it("falls back to the AU1 token only when no US1 key is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: "GT123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { TWILIO_US1_API_KEY_SID, TWILIO_US1_API_KEY_SECRET, ...noUs1 } = env;
    await requestTranscript(noUs1, "RExxx", { staffChannel: 2 });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("ACxxx:au1tok")}`);
  });

  // #115 fixed the AU1-vs-US1 host mismatch, but real calls right after that deploy still came back
  // request_failed with nothing saying WHAT Twilio actually answered THIS time -- only a console.log
  // line nobody was tailing. `error` is what the recording-status webhook now persists alongside
  // `intelligence_status = 'request_failed'`, so Health Checks can quote it directly.
  it("returns Twilio's status and body when the create request is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"code":20003,"message":"Authenticate"}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestTranscript(env, "RExxx", { staffChannel: 2 });
    expect(result.sid).toBeNull();
    expect(result.error).toContain("401");
    expect(result.error).toContain("US1 key");
    expect(result.error).toContain("Authenticate");
  });

  it("says which credential went out when the request is refused with no US1 key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const { TWILIO_US1_API_KEY_SID, TWILIO_US1_API_KEY_SECRET, ...noUs1 } = env;
    const result = await requestTranscript(noUs1, "RExxx", { staffChannel: 2 });
    expect(result.sid).toBeNull();
    expect(result.error).toContain("403");
    expect(result.error).toContain("AU1 token");
  });

  it("returns the fetch failure message when Twilio cannot be reached at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const result = await requestTranscript(env, "RExxx", { staffChannel: 2 });
    expect(result.sid).toBeNull();
    expect(result.error).toContain("network down");
  });

  // A TEXT column read back on a Health Checks screen, not a log viewer -- Twilio's own error body
  // is client-supplied-shaped content riding through OUR code, and there is no reason to let it grow
  // that column without bound.
  it("truncates an oversized error body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("x".repeat(2000), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestTranscript(env, "RExxx", { staffChannel: 2 });
    expect(result.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("formatLabelledTranscript", () => {
  it("labels each speaker by channel", () => {
    const text = formatLabelledTranscript([s(2, "Would that be Phil?", 0), s(1, "Yes, how are you?", 1)], 1);
    expect(text).toBe("Customer: Would that be Phil?\n\nStaff: Yes, how are you?");
  });

  it("respects which channel the staff member is on", () => {
    const sentences = [s(2, "Would that be Phil?", 0), s(1, "Yes, how are you?", 1)];
    expect(formatLabelledTranscript(sentences, 2)).toBe(
      "Staff: Would that be Phil?\n\nCustomer: Yes, how are you?"
    );
  });

  // One line per sentence turns a two-minute call into forty labelled fragments -- harder to read
  // than the unlabelled blob this replaces.
  it("joins consecutive sentences from the same speaker into one turn", () => {
    const text = formatLabelledTranscript(
      [s(2, "Hello.", 0), s(2, "My name's Robbie.", 1), s(1, "Go on.", 2)],
      1
    );
    expect(text).toBe("Customer: Hello. My name's Robbie.\n\nStaff: Go on.");
  });

  // THE case that matters: without dual-channel conference recording turned on in the Console,
  // every sentence comes back on channel 1. Labelling that would be a guess presented as fact, so
  // it returns nothing and the caller keeps the Whisper transcript.
  it("returns nothing when the recording was not dual-channel", () => {
    expect(formatLabelledTranscript([s(1, "Hello.", 0), s(1, "Yes, speaking.", 1)], 1)).toBe("");
  });

  it("returns nothing when there is nothing to say", () => {
    expect(formatLabelledTranscript([], 1)).toBe("");
    expect(formatLabelledTranscript([s(1, "   ", 0), s(2, "", 1)], 1)).toBe("");
  });

  it("orders turns by sentence index, not by arrival", () => {
    const text = formatLabelledTranscript([s(1, "Second.", 1), s(2, "First.", 0)], 1);
    expect(text).toBe("Customer: First.\n\nStaff: Second.");
  });
});

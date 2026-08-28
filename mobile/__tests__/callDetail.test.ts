/// <reference types="jest" />

jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { getCallDetail, type Call } from "../src/lib/api";

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

// The API returns two independent transcript fields (SELECT * over `calls`): `transcription` for a
// voicemail message and `call_transcript` for the recording of an answered call. The mobile Call
// type previously declared only `transcription`, so answered-call transcripts -- which is what the
// database actually holds -- were dropped on the floor and the detail screen showed nothing while
// the web app showed them.
describe("getCallDetail transcripts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (session.getToken as jest.Mock).mockResolvedValue("tok");
  });

  const baseCall = {
    id: "CA1",
    caller_number: "+61400000000",
    called_number: "+61866108941",
    started_at: 1_700_000_000_000,
    ended_at: null,
    status: "completed",
    direction: "inbound" as const,
    recording_sid: "RE1",
    recording_url: "https://api.twilio.com/r/RE1",
    disposition: null,
    notes: null,
  };

  it("surfaces an answered call's call_transcript", async () => {
    (global as any).fetch = jest.fn().mockReturnValue(
      okJson({ call: { ...baseCall, transcription: null, call_transcript: "Booking confirmed for Tuesday." }, events: [] })
    );

    const { call } = await getCallDetail("CA1");

    expect(call.call_transcript).toBe("Booking confirmed for Tuesday.");
    expect(call.transcription).toBeNull();
  });

  it("surfaces a voicemail's transcription", async () => {
    (global as any).fetch = jest.fn().mockReturnValue(
      okJson({ call: { ...baseCall, transcription: "Please call me back.", call_transcript: null }, events: [] })
    );

    const { call } = await getCallDetail("CA1");

    expect(call.transcription).toBe("Please call me back.");
    expect(call.call_transcript).toBeNull();
  });

  it("keeps the two transcripts separate when a call has both", async () => {
    (global as any).fetch = jest.fn().mockReturnValue(
      okJson({ call: { ...baseCall, transcription: "voicemail text", call_transcript: "call text" }, events: [] })
    );

    const { call } = await getCallDetail("CA1");

    expect(call.transcription).toBe("voicemail text");
    expect(call.call_transcript).toBe("call text");
  });

  // Compile-time guard: dropping either field from the Call type fails typecheck here.
  it("declares both transcript fields on the Call type", () => {
    const call: Pick<Call, "transcription" | "call_transcript"> = {
      transcription: null,
      call_transcript: null,
    };
    expect(call).toEqual({ transcription: null, call_transcript: null });
  });
});

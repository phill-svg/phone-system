import { describe, it, expect, vi } from "vitest";
import { findConferenceSid, setParticipantHold, removeParticipant, listParticipants } from "../../src/twilio/conferenceClient";

describe("findConferenceSid", () => {
  it("returns the first conference's Sid for a matching friendly name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ conferences: [{ sid: "CFxxx" }] }), { status: 200 }))
    );
    expect(await findConferenceSid("ACxxx", "authtoken", "CAcaller")).toBe("CFxxx");
  });

  it("returns null when no conference matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ conferences: [] }), { status: 200 })));
    expect(await findConferenceSid("ACxxx", "authtoken", "CAcaller")).toBeNull();
  });
});

describe("setParticipantHold", () => {
  it("POSTs Hold=true to the participant resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await setParticipantHold("ACxxx", "authtoken", "CFxxx", "CAcaller", true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Conferences/CFxxx/Participants/CAcaller.json",
      expect.objectContaining({ method: "POST" })
    );
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("Hold")).toBe("true");
  });
});

describe("listParticipants", () => {
  it("GETs the participants resource and maps call_sid to callSid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ participants: [{ call_sid: "CAself" }, { call_sid: "CAother" }] }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await listParticipants("ACxxx", "authtoken", "CFxxx");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Conferences/CFxxx/Participants.json",
      expect.objectContaining({ headers: expect.anything() })
    );
    expect(result).toEqual([{ callSid: "CAself" }, { callSid: "CAother" }]);
  });
});

describe("removeParticipant", () => {
  it("DELETEs the participant resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await removeParticipant("ACxxx", "authtoken", "CFxxx", "CAagent");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Conferences/CFxxx/Participants/CAagent.json",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});

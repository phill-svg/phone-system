import { describe, it, expect } from "vitest";
import { renderJoinConference, renderDialAgentIntoConference } from "../../src/twilio/conferenceTwiml";

describe("renderJoinConference", () => {
  it("renders a Dial/Conference document for the given name", () => {
    const xml = renderJoinConference({ conferenceName: "CAcaller" });
    // Pinned to a fixed region (au1) so this leg mixes in the SAME room as the other leg's
    // <Conference>, regardless of which Twilio region created/is processing either underlying call.
    expect(xml).toContain('<Conference region="au1"');
    expect(xml).toContain('waitUrl="https://tcbvoip.app/media/system/ringback-au.wav"');
    expect(xml).toContain('beep="false"');
    expect(xml).toContain(">CAcaller</Conference></Dial>");
  });
});

describe("renderDialAgentIntoConference", () => {
  it("renders a Dial/Conference document with action + recording attributes", () => {
    const xml = renderDialAgentIntoConference({
      conferenceName: "CAcaller",
      actionUrl: "https://x/action",
      recordingStatusCallbackUrl: "https://x/rec",
    });
    expect(xml).toContain('action="https://x/action"');
    expect(xml).toContain('recordingStatusCallback="https://x/rec"');
    expect(xml).toContain('<Conference region="au1"');
    expect(xml).toContain(">CAcaller</Conference>");
  });

  // The whole reason speaker labelling works. A <Conference> recording's channel count is governed by
  // one account-wide Console switch, which on 2026-09-12 was enabled, saved, and STILL producing mono
  // (Twilio's Recordings API: channels 1, source Conference, on a 143-second call). Recording on the
  // <Dial> instead is a DialVerb recording, which no account setting touches.
  //
  // Asserted positionally, not just by substring: `record` must be an attribute of the <Dial> and
  // must NOT appear on the <Conference>, because putting it back on the noun is exactly the
  // regression -- and it would still satisfy a bare toContain('record="record-from-answer-dual"').
  it("records dual-channel on the Dial, never on the Conference", () => {
    const xml = renderDialAgentIntoConference({
      conferenceName: "CAcaller",
      actionUrl: "https://x/action",
      recordingStatusCallbackUrl: "https://x/rec",
    });
    const dialTag = xml.slice(xml.indexOf("<Dial"), xml.indexOf(">", xml.indexOf("<Dial")) + 1);
    const confTag = xml.slice(xml.indexOf("<Conference"), xml.indexOf(">", xml.indexOf("<Conference")) + 1);
    expect(dialTag).toContain('record="record-from-answer-dual"');
    expect(dialTag).toContain('recordingStatusCallback="https://x/rec"');
    expect(confTag).not.toContain("record");
    // Mono, or recording the conference, would both silently un-label every transcript.
    expect(xml).not.toContain("record-from-start");
  });

  it("omits recording attributes when record is false", () => {
    const xml = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r", record: false });
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("recordingStatusCallback");
  });
  it("records by default (record omitted) and when record is true", () => {
    const def = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r" });
    expect(def).toContain('record="record-from-answer-dual"');
  });

  // The whisper is for a divert leg whose screen showed the CUSTOMER's number: without it a work
  // call is indistinguishable from a personal one until someone speaks.
  it("whispers that this is a work call, before the Dial, when asked", () => {
    const xml = renderDialAgentIntoConference({
      conferenceName: "CAx",
      actionUrl: "https://x/a",
      recordingStatusCallbackUrl: "https://x/r",
      whisper: true,
    });
    expect(xml).toContain("<Say>T C B call.</Say>");
    // It MUST precede the <Dial>: inside it, the customer (already in the conference) would hear it
    // too, and after it, it would never play at all.
    expect(xml.indexOf("<Say>")).toBeLessThan(xml.indexOf("<Dial"));
  });

  it("stays silent by default, so a softphone leg is unchanged", () => {
    const xml = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r" });
    expect(xml).not.toContain("<Say>");
  });
});

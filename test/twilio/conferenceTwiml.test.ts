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

  // THE recording for an inbound call, and it has to be on THIS document rather than the staff
  // leg's. One caller, one leg, lasting the whole call across any transfer -- so one continuous
  // recording that no second leg can overwrite. Its parent call is the customer, which is what makes
  // `transcript_staff_channel` default 2 structural instead of a guess about conference join order.
  //
  // Positional, because `record` on the <Conference> instead would be mono (governed by an account
  // switch verified not to work) and would still satisfy a bare toContain('record=').
  it("records dual-channel on the caller's Dial when asked", () => {
    const xml = renderJoinConference({
      conferenceName: "CAcaller",
      record: true,
      recordingStatusCallbackUrl: "https://x/rec?conference=1",
    });
    const dialTag = xml.slice(xml.indexOf("<Dial"), xml.indexOf(">", xml.indexOf("<Dial")) + 1);
    const confTag = xml.slice(xml.indexOf("<Conference"), xml.indexOf(">", xml.indexOf("<Conference")) + 1);
    expect(dialTag).toContain('record="record-from-answer-dual"');
    expect(dialTag).toContain('recordingStatusCallback="https://x/rec?conference=1"');
    expect(confTag).not.toContain("record");
  });

  it("records nothing when recording is off", () => {
    const xml = renderJoinConference({ conferenceName: "CAx", record: false, recordingStatusCallbackUrl: "https://x/r" });
    expect(xml).not.toContain("record");
    expect(xml).not.toContain("recordingStatusCallback");
  });

  // A callback URL is required to record: recording with nowhere to report it would bill per minute
  // for audio no call row ever learns about, and the supervisor listen-in path renders this too.
  it("does not record when no callback URL was supplied", () => {
    const xml = renderJoinConference({ conferenceName: "CAx", record: true });
    expect(xml).not.toContain("record");
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

  // A <Dial> recording belongs to EVERY leg that renders this document, and two do per call on a
  // warm transfer (original staff leg, then the target's) or an outbound softphone call (agent leg,
  // then the dialled customer). Both post to the same callback, `recording_url` is last-write-wins,
  // and half the conversation ends up orphaned in Twilio. That shipped on 2026-09-12 and was caught
  // the same hour, so the recording here stays CONFERENCE-level -- one recording however many legs
  // ask for it -- and the dual-channel one lives on the caller's leg instead.
  //
  // Asserted positionally rather than by substring, because `record` on the <Dial> is the exact
  // regression and would still satisfy a bare toContain('record=').
  it("records the Conference, never the Dial, so two legs cannot record one call twice", () => {
    const xml = renderDialAgentIntoConference({
      conferenceName: "CAcaller",
      actionUrl: "https://x/action",
      recordingStatusCallbackUrl: "https://x/rec",
    });
    const dialTag = xml.slice(xml.indexOf("<Dial"), xml.indexOf(">", xml.indexOf("<Dial")) + 1);
    const confTag = xml.slice(xml.indexOf("<Conference"), xml.indexOf(">", xml.indexOf("<Conference")) + 1);
    expect(confTag).toContain('record="record-from-start"');
    expect(confTag).toContain('recordingStatusCallback="https://x/rec"');
    expect(dialTag).not.toContain("record");
    expect(xml).not.toContain("record-from-answer-dual");
  });

  it("omits recording attributes when record is false", () => {
    const xml = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r", record: false });
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("recordingStatusCallback");
  });
  it("records by default (record omitted) and when record is true", () => {
    const def = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r" });
    expect(def).toContain('record="record-from-start"');
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

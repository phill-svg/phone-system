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
    expect(xml).toContain('record="record-from-start"');
    expect(xml).toContain('recordingStatusCallback="https://x/rec"');
    expect(xml).toContain('<Conference region="au1"');
    expect(xml).toContain(">CAcaller</Conference>");
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
});

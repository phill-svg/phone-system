import { describe, it, expect } from "vitest";
import { renderJoinConference, renderDialAgentIntoConference } from "../../src/twilio/conferenceTwiml";

describe("renderJoinConference", () => {
  it("renders a Dial/Conference document for the given name", () => {
    const xml = renderJoinConference({ conferenceName: "CAcaller" });
    expect(xml).toContain("<Dial><Conference>CAcaller</Conference></Dial>");
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
    expect(xml).toContain("<Conference");
    expect(xml).toContain(">CAcaller</Conference>");
  });
});

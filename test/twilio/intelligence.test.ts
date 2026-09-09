import { describe, expect, it } from "vitest";
import { formatLabelledTranscript, intelligenceEnabled, type Sentence } from "../../src/twilio/intelligence";

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

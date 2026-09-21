import { describe, expect, it } from "vitest";
import { buildLabelledTurns, formatLabelledTurns } from "../src/labelledTranscript";

describe("buildLabelledTurns", () => {
  // The headline case: two monologues, one conversation, in the order it happened.
  it("interleaves the two channels by when each segment was spoken", () => {
    const turns = buildLabelledTurns(
      { text: "Hello? I have a rat problem. Kambah, in the roof.", segments: [
        { start: 0.2, text: "Hello? I have a rat problem." },
        { start: 6.1, text: "Kambah, in the roof." },
      ] },
      { text: "Yeah no worries, whereabouts are you?", segments: [
        { start: 3.4, text: "Yeah no worries, whereabouts are you?" },
      ] }
    );
    expect(turns).toEqual([
      { who: "Customer", text: "Hello? I have a rat problem." },
      { who: "Staff", text: "Yeah no worries, whereabouts are you?" },
      { who: "Customer", text: "Kambah, in the roof." },
    ]);
  });

  // One line per Whisper segment makes a two-minute call forty fragments, which reads worse than
  // the unlabelled transcript this replaces.
  it("joins consecutive segments from the same speaker into one turn", () => {
    const turns = buildLabelledTurns(
      { text: "", segments: [] },
      { text: "TCB pest control. Phill speaking.", segments: [
        { start: 0, text: "TCB pest control." },
        { start: 1.5, text: "Phill speaking." },
      ] }
    );
    expect(turns).toEqual([{ who: "Staff", text: "TCB pest control. Phill speaking." }]);
  });

  // Timings are a property of the model's response, not a contract. Without them every word is
  // still attributed correctly -- just as two blocks instead of a dialogue.
  it("falls back to one turn per speaker when a channel has no timings", () => {
    const turns = buildLabelledTurns(
      { text: "I have a rat problem." },
      { text: "Whereabouts are you?" }
    );
    expect(turns).toEqual([
      { who: "Customer", text: "I have a rat problem." },
      { who: "Staff", text: "Whereabouts are you?" },
    ]);
  });

  // A segment that cannot be placed in time must not be dropped silently or pushed to the front:
  // the whole channel falls back to the block form, which keeps every word.
  it("falls back when a segment has no usable start time", () => {
    const turns = buildLabelledTurns(
      { text: "First then second.", segments: [
        { start: 0, text: "First" },
        { start: "later", text: "then second." },
      ] },
      { text: "Right.", segments: [{ start: 1, text: "Right." }] }
    );
    expect(turns).toEqual([
      { who: "Customer", text: "First then second." },
      { who: "Staff", text: "Right." },
    ]);
  });

  it("says nothing when neither side said anything", () => {
    expect(buildLabelledTurns({ text: "" }, { text: "   " })).toEqual([]);
  });

  it("omits a silent channel rather than labelling an empty turn", () => {
    expect(buildLabelledTurns({ text: "" }, { text: "Anyone there?" })).toEqual([
      { who: "Staff", text: "Anyone there?" },
    ]);
  });
});

describe("formatLabelledTurns", () => {
  it("renders one labelled paragraph per turn", () => {
    expect(
      formatLabelledTurns([
        { who: "Customer", text: "Hello?" },
        { who: "Staff", text: "TCB pest control." },
      ])
    ).toBe("Customer: Hello?\n\nStaff: TCB pest control.");
  });

  it("is empty when there are no turns, so nothing overwrites a real transcript with a label", () => {
    expect(formatLabelledTurns([])).toBe("");
  });
});

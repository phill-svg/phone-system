import { reseedDraft, wholeNumberInput } from "../src/lib/draft";

// A cleared number box commits NOTHING. The staff ring-priority field used `Number("")`, which is 0:
// clear the box, dismiss the keyboard, and that person was saved to the front of the ring order.
describe("wholeNumberInput", () => {
  it("commits nothing while the box is empty", () => {
    expect(wholeNumberInput("", 0)).toEqual({ text: "", value: null });
    expect(wholeNumberInput(" ", 0)).toEqual({ text: "", value: null });
  });

  it("keeps digits only and commits the number", () => {
    expect(wholeNumberInput("1a2", 0)).toEqual({ text: "12", value: 12 });
  });

  it("allows zero where zero is legitimate, and floors it where it is not", () => {
    expect(wholeNumberInput("0", 0).value).toBe(0);
    expect(wholeNumberInput("0", 1).value).toBe(1);
  });
});

// The phone-numbers screen reloads the whole list after any one card saves, removes or adds, and
// every card used to re-seed its draft from the reload -- discarding unsaved edits on the OTHER
// cards. A draft is only replaced when it still holds what was last seeded into it.
describe("reseedDraft", () => {
  const server = { label: "Main", voice: true };

  it("replaces an untouched draft with the incoming server copy", () => {
    const incoming = { label: "Main line", voice: true };
    expect(reseedDraft({ ...server }, server, incoming)).toEqual(incoming);
  });

  it("keeps an edited draft when another card's save reloads the list", () => {
    const edited = { label: "Typed but not saved", voice: false };
    expect(reseedDraft(edited, server, { ...server })).toEqual(edited);
  });

  it("keeps an edited draft even when the server copy changed underneath it", () => {
    const edited = { label: "Mine", voice: true };
    expect(reseedDraft(edited, server, { label: "Theirs", voice: true })).toEqual(edited);
  });

  // Field by field: keeping the WHOLE draft kept fields nobody touched. Card B had an unsaved label
  // and was the default; card A was saved as the new default, the server cleared B's flag, B kept
  // "default" in its draft -- and saving B's label later silently took the default back.
  it("takes server-owned fields from the reload even when other fields are edited", () => {
    const b = { label: "Office", default_voice: true };
    const edited = { label: "Office (typing)", default_voice: true };
    expect(reseedDraft(edited, b, { label: "Office", default_voice: false }, ["default_voice"])).toEqual({
      label: "Office (typing)",
      default_voice: false,
    });
  });

  // The server trims the label. "Office " saved came back "Office", which differed from both the
  // draft and the seed, so the card stayed on Save forever re-sending the untrimmed value.
  it("treats a value the server only trimmed as saved", () => {
    expect(reseedDraft({ label: "Office " }, { label: "Old" }, { label: "Office" })).toEqual({ label: "Office" });
  });

  // After this card's own save the reload carries exactly the draft, and the seed moves with it,
  // so the next outside change still lands.
  it("follows outside changes again once the draft has been saved", () => {
    const saved = { label: "Saved", voice: true };
    expect(reseedDraft(saved, server, saved)).toEqual(saved);
    const later = { label: "Changed on the web", voice: true };
    expect(reseedDraft(saved, saved, later)).toEqual(later);
  });
});

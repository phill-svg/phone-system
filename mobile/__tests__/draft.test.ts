import { reseedDraft } from "../src/lib/draft";

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
    expect(reseedDraft(edited, server, { ...server })).toBe(edited);
  });

  it("keeps an edited draft even when the server copy changed underneath it", () => {
    const edited = { label: "Mine", voice: true };
    expect(reseedDraft(edited, server, { label: "Theirs", voice: true })).toBe(edited);
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

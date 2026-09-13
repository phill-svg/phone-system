// What an edit form's draft should become when its server copy reloads.
//
// `lastSeeded` is the server copy the draft was last filled from. A draft that still equals it has
// not been touched and follows the reload; one that differs holds unsaved typing and is kept. The
// caller moves `lastSeeded` to `incoming` on every reload, so a card whose own save comes back
// (draft === incoming) is clean again from then on.
// What a whole-number box shows, and what (if anything) it commits, for the text just typed. Empty
// commits NOTHING -- `Number("")` is 0, which is how clearing a box used to save a zero.
export function wholeNumberInput(raw: string, min: number): { text: string; value: number | null } {
  const text = raw.replace(/\D/g, "");
  return { text, value: text === "" ? null : Math.max(min, Number(text)) };
}

export function reseedDraft<T>(current: T, lastSeeded: T, incoming: T): T {
  return JSON.stringify(current) === JSON.stringify(lastSeeded) ? incoming : current;
}

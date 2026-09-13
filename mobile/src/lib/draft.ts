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

// Field by field, not the whole draft: keeping every field of an edited draft kept ones nobody
// touched -- a default flag another card's save had moved came back on the next save of this one.
// A field follows the reload when it is untouched, or when the server copy CHANGED to what was typed
// give or take surrounding spaces (the server trims, and a saved card otherwise stays on "Save"
// forever). Only when it changed: a reload that moved nothing must not eat a space still being typed.
export function reseedDraft<T extends Record<string, unknown>>(current: T, lastSeeded: T, incoming: T): T {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const trimmedSame = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : same(a, b);
  const out = { ...current };
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    const untouched = same(current[key], lastSeeded[key]);
    const savedAsTyped = !same(incoming[key], lastSeeded[key]) && trimmedSame(current[key], incoming[key]);
    if (untouched || savedAsTyped) out[key] = incoming[key];
  }
  return out;
}

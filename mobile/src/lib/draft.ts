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
// touched. A field follows the reload when it is untouched, when the reload already holds what was
// typed (a string the server only trimmed counts -- otherwise a saved card stays on "Save" forever),
// or when it is `serverOwned`: a value other cards' saves change, like which number is the default.
export function reseedDraft<T extends Record<string, unknown>>(
  current: T,
  lastSeeded: T,
  incoming: T,
  serverOwned: (keyof T)[] = []
): T {
  const same = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : JSON.stringify(a) === JSON.stringify(b);
  const out = { ...current };
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    if (serverOwned.includes(key) || same(current[key], lastSeeded[key]) || same(current[key], incoming[key])) {
      out[key] = incoming[key];
    }
  }
  return out;
}

// What an edit form's draft should become when its server copy reloads.
//
// `lastSeeded` is the server copy the draft was last filled from. A draft that still equals it has
// not been touched and follows the reload; one that differs holds unsaved typing and is kept. The
// caller moves `lastSeeded` to `incoming` on every reload, so a card whose own save comes back
// (draft === incoming) is clean again from then on.
export function reseedDraft<T>(current: T, lastSeeded: T, incoming: T): T {
  return JSON.stringify(current) === JSON.stringify(lastSeeded) ? incoming : current;
}

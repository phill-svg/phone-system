import { describe, expect, it } from "vitest";
import { renderIvrFlowPage } from "../../src/html/pages/ivrFlow";

// A hold step's callback key leads to a step of its own, so what callers hear when they press it is
// an ordinary, editable step. The Hold card therefore needs a connector for it. The REAL emitted
// outsFor() runs here.
function outsFor() {
  const html = renderIvrFlowPage("main", [], [], []);
  const m = /(function outsFor\(n\)\{[\s\S]*?\n {6}\})/.exec(html);
  if (!m) throw new Error("could not find outsFor() in the emitted editor script");
  return new Function(`${m[1]}; return outsFor;`)() as (n: unknown) => { label: string; field?: string }[];
}

describe("the phone-menu editor's Hold card", () => {
  it("has a connector for the callback key, labelled with the key", () => {
    const hold = { type: "wait", config: { allowCallbackStar: true, callbackKey: "1", nextNodeId: "" } };
    expect(outsFor()(hold)).toEqual([
      { label: "Next", field: "nextNodeId" },
      { label: "Press 1 (callback)", field: "callbackNextNodeId" },
    ]);
  });

  it("has no callback connector when the step offers no callback", () => {
    const hold = { type: "wait", config: { allowCallbackStar: false, nextNodeId: "" } };
    expect(outsFor()(hold)).toEqual([{ label: "Next", field: "nextNodeId" }]);
  });
});

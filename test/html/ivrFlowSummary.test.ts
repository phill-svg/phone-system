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

// Refused at the moment of connecting, not only at Save.
describe("connecting a Hold card's callback line", () => {
  function setOutTarget(nodes: Record<string, { type: string }>) {
    const html = renderIvrFlowPage("main", [], [], []);
    const start = html.indexOf("function setOutTarget(n, out, val){");
    const end = html.indexOf("\n", html.indexOf("if(out.opt!=null) c.options[out.opt].nextNodeId=val;", start));
    if (start < 0 || end < 0) throw new Error("could not find setOutTarget() in the emitted editor script");
    const alerts: string[] = [];
    const fn = new Function("getNode", "alert", `${html.slice(start, end)}; return setOutTarget;`)(
      (id: string) => nodes[id],
      (msg: string) => alerts.push(msg)
    ) as (n: unknown, out: unknown, val: string) => void;
    return { fn, alerts };
  }

  it("refuses a step that is not a callback step", () => {
    const { fn, alerts } = setOutTarget({ vm: { type: "voicemail" } });
    const hold = { config: { callbackNextNodeId: "" } };
    fn(hold, { field: "callbackNextNodeId" }, "vm");
    expect(hold.config.callbackNextNodeId).toBe("");
    expect(alerts.length).toBe(1);
  });

  it("connects a callback step", () => {
    const { fn, alerts } = setOutTarget({ cb: { type: "callback" } });
    const hold = { config: { callbackNextNodeId: "" } };
    fn(hold, { field: "callbackNextNodeId" }, "cb");
    expect(hold.config.callbackNextNodeId).toBe("cb");
    expect(alerts.length).toBe(0);
  });
});

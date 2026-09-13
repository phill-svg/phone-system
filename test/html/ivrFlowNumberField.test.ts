import { describe, expect, it } from "vitest";
import { renderIvrFlowPage } from "../../src/html/pages/ivrFlow";

type Handler = (ev: { target: unknown }) => void;

// The web IVR editor wrote `parseInt(value)||0` on every keystroke, so clearing "Digits to collect"
// to retype it stored numDigits:0 -- a live <Gather numDigits="0">. The REAL emitted input handler is
// pulled out of the page and run against a stub node.
function inputHandler(node: unknown): Handler {
  const html = renderIvrFlowPage("main", [], [], []);
  const m = /panel\.addEventListener\("input", (function\(ev\)\{[\s\S]*?\n {6}\})\);/.exec(html);
  if (!m) throw new Error("could not find the panel input handler in the emitted IVR editor script");
  const factory = new Function(
    "node",
    `var selId = "n1";
     function getNode() { return node; }
     function drawLines() {} function syncNode() {} function renderPanel() {}
     return ${m[1]};`
  );
  return factory(node) as Handler;
}

function numberBox(field: string, value: string) {
  const attrs: Record<string, string> = { "data-fld": field, "data-num": "1" };
  return { value, checked: false, getAttribute: (a: string) => attrs[a] ?? null };
}

describe("web IVR editor number fields", () => {
  it("does not commit an empty box as zero", () => {
    const node = { id: "n1", type: "input", config: { numDigits: 4 } };
    inputHandler(node)({ target: numberBox("numDigits", "") });
    expect(node.config.numDigits).toBe(4);
  });

  // Zero retries is a legitimate answer, so a typed 0 still commits.
  it("commits a typed number, zero included", () => {
    const node = { id: "n1", type: "gather", config: { retryLimit: 3 } };
    inputHandler(node)({ target: numberBox("retryLimit", "0") });
    expect(node.config.retryLimit).toBe(0);
  });
});

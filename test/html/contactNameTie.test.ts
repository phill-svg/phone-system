import { describe, expect, it } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";
import { renderPhonePage } from "../../src/html/pages/phone";
import { renderIvrFlowPage } from "../../src/html/pages/ivrFlow";

// A number saved as two contacts must get ONE name on every surface. /api/contacts is ordered by
// name, and the server-rendered pages and findContactByPhone take the FIRST; the browser pages must
// too. The REAL emitted loadContacts() runs here against that ordered list.
const LIST = [
  { name: "Alice Smith", phone_normalized: "61400000009" },
  { name: "Zed Plumbing", phone_normalized: "61400000009" },
];

function slice(html: string, start: string, end: string): string {
  const i = html.indexOf(start);
  const j = html.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`could not find ${start}`);
  return html.slice(i, j + end.length);
}

describe("a number saved as two contacts", () => {
  it("Messages names it by the first contact", async () => {
    const src = slice(renderMessagesPage(), "function loadContacts(){", "}).catch(function(){}); }");
    const names = await new Function(
      "api",
      `var contactsByNorm = {}; ${src}; return loadContacts().then(function(){ return contactsByNorm; });`
    )(() => Promise.resolve(LIST));
    expect(names["61400000009"].name).toBe("Alice Smith");
  });

  it("the Phone page names it by the first contact", async () => {
    const src = slice(renderPhonePage("phill@b.com"), "async function loadContacts() {", "renderContacts(); else renderCalls();");
    const names = await new Function(
      "fetch",
      `var contacts = [], contactsByNorm = {}, listMode = "calls"; function renderContacts(){} function renderCalls(){}
       ${src} } catch (e) {} }
       return loadContacts().then(function(){ return contactsByNorm; });`
    )(() => Promise.resolve({ ok: true, json: () => Promise.resolve(LIST) }));
    expect(names["61400000009"].name).toBe("Alice Smith");
  });
});

// Deleting a step clears lines into it -- including the hold step's callback line, whose "built-in
// message" button lives in the SELECTED step's panel -- so the panel is redrawn even when the
// deleted step is not the selected one.
describe("deleting a step in the phone-menu editor", () => {
  it("redraws the panel of the step still selected", () => {
    const src = slice(renderIvrFlowPage("main", [], [], []), "function deleteNode(id){", "render();\n      }");
    let panels = 0;
    const nodes = [
      { id: "h", type: "wait", config: { callbackNextNodeId: "cb" } },
      { id: "cb", type: "callback", config: {} },
    ];
    new Function("nodes", "selId", "entryId", "renderPanel", "render", `${src}; deleteNode("cb");`)(
      nodes,
      "h",
      "h",
      () => panels++,
      () => {}
    );
    expect(nodes[0].config.callbackNextNodeId).toBe("");
    expect(panels).toBe(1);
  });
});

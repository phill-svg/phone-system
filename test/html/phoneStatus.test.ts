import { describe, expect, it, vi } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// The web Offline button must NOT send {status:'offline', awayReason:null}: that is exactly what older
// desktop apps send when they QUIT, and the server ignores that body from Electron (see
// isDesktopQuitOffline in src/api/softphone.ts). If the button sent it, Offline would silently do
// nothing inside the desktop app.
//
// The REAL emitted setStatus and click handler run against a stubbed fetch, so this asserts the bytes
// actually sent, not the source text.
function clickAndCapture(buttonId: string): Record<string, unknown> {
  const html = renderPhonePage("phill@b.com");
  const setStatus = /(async function setStatus\(status, awayReason\) \{[\s\S]*?\n {6}\})/.exec(html)?.[1];
  const listener = new RegExp(`(document\\.getElementById\\('${buttonId}'\\)\\.addEventListener\\('click', function \\(\\) \\{[^\\n]*\\}\\);)`).exec(html)?.[1];
  if (!setStatus || !listener) throw new Error("could not find setStatus / the button handler in the emitted phone script");
  const handlers: Record<string, () => void> = {};
  const document = {
    getElementById: (id: string) => ({
      id,
      textContent: "",
      style: {},
      addEventListener: (_evt: string, h: () => void) => (handlers[id] = h),
    }),
  };
  const fetch = vi.fn(() => new Promise(() => {}));
  new Function("document", "fetch", `function highlightStatusButtons() {}\n${setStatus}\n${listener}`)(document, fetch);
  handlers[buttonId]();
  const init = (fetch.mock.calls[0] as unknown as [string, { body: string }])[1];
  return JSON.parse(init.body);
}

describe("web status buttons", () => {
  it("Offline sends {status} alone, never the desktop quit body", () => {
    expect(clickAndCapture("status-offline-btn")).toEqual({ status: "offline" });
  });

  it("Available still clears the away reason explicitly", () => {
    expect(clickAndCapture("status-available-btn")).toEqual({ status: "available", awayReason: null });
  });
});

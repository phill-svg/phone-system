import { describe, expect, it, vi } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// A call that rings this browser and is answered on someone else's phone fires 'cancel'. That was
// bound to onCallEnded, which calls showDetail('empty') -- so whatever pane was open, unsaved call
// notes included, was thrown away by a call this browser never took.
//
// The REAL emitted handlers are pulled out of the page and run against stubs, so a regression in
// phone.ts has to reach this test. Any helper that exists only after the fix is optional here, so
// against the old code the test fails on BEHAVIOUR, not on a missing function.
function harness() {
  const html = renderPhonePage("phill@b.com");
  const fn = (name: string) => new RegExp(`(function ${name}\\(\\w*\\) \\{[\\s\\S]*?\\n      \\})`).exec(html)?.[1] ?? "";
  const incoming = /(device\.on\('incoming', function \(call\) \{[\s\S]*?\n {10}\}\);)/.exec(html)?.[1];
  if (!fn("onCallEnded") || !incoming) throw new Error("could not find the incoming-call handlers in the emitted phone script");

  const showDetail = vi.fn();
  const hideIncomingBanner = vi.fn();
  const el = () => ({ style: {} as Record<string, string> });
  const run = new Function(
    "showDetail",
    "hideIncomingBanner",
    "document",
    `var activeCall = null; var isOnHold = false;
     var window = {};
     function showIncomingBanner() {}
     function incomingCallerNumber() { return '+61400000000'; }
     function onCallConnected() {}
     function loadCalls() {}
     function setTimeout() {}
     ${fn("onCallEnded")}
     ${fn("onIncomingGone")}
     var device = { on: function (evt, h) { this.handler = h; } };
     ${incoming}
     return { device: device, activeCall: function () { return activeCall; } };`
  );
  const page = run(showDetail, hideIncomingBanner, { getElementById: el }) as {
    device: { handler: (call: unknown) => void };
    activeCall: () => unknown;
  };
  const ring = () => {
    const handlers: Record<string, () => void> = {};
    const call = { on: (evt: string, h: () => void) => (handlers[evt] = h) };
    page.device.handler(call);
    return handlers;
  };
  return { page, ring, showDetail, hideIncomingBanner };
}

describe("an incoming call that never connected here", () => {
  for (const evt of ["cancel", "reject"]) {
    it(`leaves the open pane alone on '${evt}'`, () => {
      const { page, ring, showDetail, hideIncomingBanner } = harness();
      const handlers = ring();
      handlers[evt]();
      expect(showDetail).not.toHaveBeenCalled();
      expect(hideIncomingBanner).toHaveBeenCalled();
      expect(page.activeCall()).toBeNull();
    });
  }

  it("still clears the pane when a call that connected here disconnects", () => {
    const { ring, showDetail } = harness();
    ring().disconnect();
    expect(showDetail).toHaveBeenCalledWith("empty");
  });
});

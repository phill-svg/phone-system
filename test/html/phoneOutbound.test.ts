import { describe, expect, it, vi } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// An outbound call showed its pane -- the only Hang up there is -- on the Call's 'accept' event,
// and nothing before it. Reported 2026-09-28 from the desktop app: "no calling screen", and a call
// sitting in the other person's voicemail could not be hung up. The pane now shows the moment
// Call is pressed, and Hang up works even before device.connect has resolved.
//
// The REAL emitted functions are pulled out of the page and run against stubs, so a regression in
// phone.ts has to reach this test. showCallPane exists only after the fix, so it is optional here:
// against the old code the test fails on BEHAVIOUR, not on a missing function.
function harness() {
  const html = renderPhonePage("phill@b.com");
  const grab = (re: RegExp) => re.exec(html)?.[1] ?? "";
  const placeCall = grab(/(async function placeCall\(to\) \{[\s\S]*?\n {6}\})/);
  const onCallEnded = grab(/(function onCallEnded\(\) \{[\s\S]*?\n {6}\})/);
  const showCallPane = grab(/(function showCallPane\([^)]*\) \{[\s\S]*?\n {6}\})/);
  const hangup = grab(/(document\.getElementById\('hangup-btn'\)\.addEventListener\('click', function \(\) \{[\s\S]*?\n {6}\}\);)/);
  if (!placeCall || !onCallEnded || !hangup) throw new Error("could not find the outbound-call code in the emitted phone script");

  const els: Record<string, { style: Record<string, string>; textContent: string; value?: string; click?: () => void }> = {};
  const document = {
    getElementById: (id: string) => {
      els[id] ??= { style: {}, textContent: "" };
      return els[id];
    },
  };
  const showDetail = vi.fn();
  const flashDeviceNote = vi.fn();
  let resolveConnect: (call: unknown) => void = () => {};
  const connect = vi.fn(() => new Promise((r) => (resolveConnect = r)));

  const run = new Function(
    "document",
    "showDetail",
    "flashDeviceNote",
    "connect",
    `var activeCall = null; var isOnHold = false; var placingCall = false; var listenConnecting = false;
     var hangupWhenPlaced = false; var contactsByNorm = {};
     var window = {};
     var device = { connect: connect };
     function callBusy() { return !!activeCall || listenConnecting || placingCall; }
     function normalizePhoneJS(n) { return n; }
     function formatAu(n) { return n; }
     function hideIncomingBanner() {}
     function incomingCallerNumber() { return null; }
     function populateTransferTargets() {}
     function onCallConnected() {}
     function loadCalls() {}
     function setTimeout() {}
     ${showCallPane}
     ${onCallEnded}
     ${placeCall}
     document.getElementById('hangup-btn').addEventListener = function (evt, h) { this.click = h; };
     ${hangup}
     return { placeCall: placeCall, activeCall: function () { return activeCall; } };`
  );
  const page = run(document, showDetail, flashDeviceNote, connect) as {
    placeCall: (to: string) => Promise<void>;
    activeCall: () => unknown;
  };
  const fakeCall = () => {
    const handlers: Record<string, () => void> = {};
    return { handlers, disconnect: vi.fn(), on: (evt: string, h: () => void) => (handlers[evt] = h) };
  };
  return { page, els, showDetail, flashDeviceNote, connect, fakeCall, resolve: (c: unknown) => resolveConnect(c) };
}

describe("placing an outbound call from the web/desktop softphone", () => {
  it("shows the call pane with Hang up as soon as Call is pressed, before it connects", async () => {
    const { page, els, showDetail } = harness();
    void page.placeCall("0438292626");
    expect(showDetail).toHaveBeenCalledWith("active");
    expect(els["active-call-controls"].style.display).toBe("block");
  });

  it("hangs up a call whose Hang up was pressed while it was still connecting", async () => {
    const { page, els, fakeCall, resolve } = harness();
    const placed = page.placeCall("0438292626");
    els["hangup-btn"].click!();
    const call = fakeCall();
    resolve(call);
    await placed;
    expect(call.disconnect).toHaveBeenCalled();
  });

  it("does not start a second call over a live one", async () => {
    const { page, connect, fakeCall, resolve, flashDeviceNote } = harness();
    const first = page.placeCall("0438292626");
    resolve(fakeCall());
    await first;
    await page.placeCall("0400000000");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(flashDeviceNote).toHaveBeenCalled();
  });

  it("takes the pane down again when the call cannot be placed", async () => {
    const { page, els, showDetail, connect } = harness();
    connect.mockImplementationOnce(() => Promise.reject(new Error("mic denied")));
    await expect(page.placeCall("0438292626")).rejects.toThrow("mic denied");
    expect(showDetail).toHaveBeenLastCalledWith("empty");
    expect(els["active-call-controls"].style.display).toBe("none");
    expect(page.activeCall()).toBeNull();
  });
});

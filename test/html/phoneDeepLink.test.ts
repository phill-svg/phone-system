import { describe, expect, it, vi } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// Every section opens in a frame inside the Phone page, so a link from Messages ("call this
// contact") or Live Calls ("listen") is handed to the running page rather than navigating to it --
// a navigation tears down the Twilio Device and hangs up the live call. The REAL emitted
// tcbPhoneDeepLink is pulled out of the page and run against stubs.
function harness(opts: { activeCall?: unknown; listenConnecting?: boolean; device?: unknown } = {}) {
  const html = renderPhonePage("phill@b.com");
  const fn = /(window\.tcbPhoneDeepLink = function \(search\) \{[\s\S]*?\n {6}\};)/.exec(html)?.[1];
  if (!fn) throw new Error("could not find tcbPhoneDeepLink in the emitted phone script");
  const input = { value: "" };
  const showDetail = vi.fn();
  const listenCall = vi.fn();
  const flashDeviceNote = vi.fn();
  const window: Record<string, (s: string) => void> = {};
  const pending = new Function(
    "window",
    "document",
    "showDetail",
    "listenCall",
    "flashDeviceNote",
    "activeCall",
    "listenConnecting",
    "device",
    `var pendingListen = null;
     ${fn}
     return function () { return pendingListen; };`
  )(
    window,
    { getElementById: () => input },
    showDetail,
    listenCall,
    flashDeviceNote,
    opts.activeCall ?? null,
    opts.listenConnecting ?? false,
    "device" in opts ? opts.device : { state: "registered" }
  ) as () => { sid: string; at: number } | null;
  return { deepLink: window.tcbPhoneDeepLink, input, showDetail, listenCall, flashDeviceNote, pending };
}

describe("deep links handed to the running phone page", () => {
  it("pre-fills the dialpad for ?dial=", () => {
    const h = harness();
    h.deepLink("?dial=%2B61400000000");
    expect(h.input.value).toBe("+61400000000");
    expect(h.showDetail).toHaveBeenCalledWith("dialpad");
    expect(h.listenCall).not.toHaveBeenCalled();
  });

  // Mid-call the pane on screen holds Hang up / Mute / Hold / Transfer, and nothing brings it back.
  it("never swaps a live call's controls away for the dial pad", () => {
    const h = harness({ activeCall: {} });
    h.deepLink("?dial=0400000000");
    expect(h.input.value).toBe("0400000000");
    expect(h.showDetail).not.toHaveBeenCalled();
  });

  it("starts a listen for ?listen= when no call is up", () => {
    const h = harness();
    h.deepLink("?listen=CA123");
    expect(h.listenCall).toHaveBeenCalledWith("CA123");
  });

  it("refuses a listen while a call is ringing or live, which it would otherwise strand", () => {
    const h = harness({ activeCall: {} });
    h.deepLink("?listen=CA123");
    expect(h.listenCall).not.toHaveBeenCalled();
    expect(h.flashDeviceNote).toHaveBeenCalledWith(expect.stringContaining("Hang up"));
  });

  // listenCall only sets activeCall once device.connect resolves, so a double click would start
  // two listen legs and strand the first with no hang-up control.
  it("refuses a second listen while the first is still connecting", () => {
    const h = harness({ listenConnecting: true });
    h.deepLink("?listen=CA456");
    expect(h.listenCall).not.toHaveBeenCalled();
  });

  // listenCall returns silently without a Device, so a listen that arrives while the page is
  // still registering would otherwise do nothing and say nothing.
  it("holds a listen until the Device has registered", () => {
    const h = harness({ device: null });
    h.deepLink("?listen=CA789");
    expect(h.listenCall).not.toHaveBeenCalled();
    expect(h.pending()?.sid).toBe("CA789");
    expect(h.flashDeviceNote).toHaveBeenCalledWith(expect.stringContaining("once the phone has connected"));
  });
});

import { describe, expect, it, vi } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// Every section opens in a frame inside the Phone page, so a link from Messages ("call this
// contact") or Live Calls ("listen") is handed to the running page rather than navigating to it --
// a navigation tears down the Twilio Device and hangs up the live call. The REAL emitted
// tcbPhoneDeepLink is pulled out of the page and run against stubs.
function harness(opts: { activeCall?: unknown; listenConnecting?: boolean; device?: unknown; deviceFailed?: boolean; waitingForLock?: boolean } = {}) {
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
     var deviceFailed = ${opts.deviceFailed ? "true" : "false"};
     var waitingForLock = ${opts.waitingForLock ? "true" : "false"};
     function callBusy() { return !!activeCall || listenConnecting; }
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

  // A softphone that failed to start will never register: queueing would promise a listen that
  // never comes.
  it("says a listen is unavailable when the phone failed to start", () => {
    const h = harness({ device: null, deviceFailed: true });
    h.deepLink("?listen=CA1");
    expect(h.pending()).toBeNull();
    expect(h.flashDeviceNote).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });

  // A tab queued behind another tab's phone may never get one: say where the phone is.
  it("points a listen at the tab with the phone, from a tab waiting for it", () => {
    const h = harness({ device: null, waitingForLock: true });
    h.deepLink("?listen=CA1");
    expect(h.pending()).toBeNull();
    expect(h.flashDeviceNote).toHaveBeenCalledWith(expect.stringContaining("tab where the phone is open"));
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

// The REAL emitted status helpers, run against a stub status element.
describe("a passing note over the device status", () => {
  function statusHarness() {
    const html = renderPhonePage("phill@b.com");
    const js = /(var noteSaved = null;[\s\S]*?function flashDeviceNote\(text\) \{[\s\S]*?\n {6}\})/.exec(html)?.[1];
    if (!js) throw new Error("could not find the status helpers");
    const classes = new Set<string>(["registered"]);
    const el = {
      textContent: "Registered",
      classList: {
        contains: (c: string) => classes.has(c),
        remove: (c: string) => classes.delete(c),
        toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
      },
    };
    const timers: Array<() => void> = [];
    const api = new Function(
      "document",
      "setTimeout",
      "clearTimeout",
      `${js}; return { flashDeviceNote: flashDeviceNote, setDeviceStatusText: setDeviceStatusText };`
    )({ getElementById: () => el }, (f: () => void) => timers.push(f), () => {}) as {
      flashDeviceNote: (t: string) => void;
      setDeviceStatusText: (t: string, r?: boolean) => void;
    };
    return { el, classes, timers, ...api };
  }

  it("puts the real status back afterwards", () => {
    const h = statusHarness();
    h.flashDeviceNote("note");
    h.timers.forEach((t) => t());
    expect(h.el.textContent).toBe("Registered");
    expect(h.classes.has("registered")).toBe(true);
  });

  // Two notes inside the window: the second must not save the first as "the real status".
  it("puts the real status back after two notes overlap", () => {
    const h = statusHarness();
    h.flashDeviceNote("A");
    h.flashDeviceNote("B");
    h.timers.forEach((t) => t());
    expect(h.el.textContent).toBe("Registered");
  });

  it("lets a status the Device reports meanwhile win", () => {
    const h = statusHarness();
    h.flashDeviceNote("A");
    h.setDeviceStatusText("Device error: boom");
    h.timers.forEach((t) => t());
    expect(h.el.textContent).toBe("Device error: boom");
  });
});

// placeCall only sets activeCall once device.connect resolves; until then a sign-in page in the
// frame or a Listen link must still see a call in progress.
describe("an outbound call still connecting", () => {
  it("counts as a call", async () => {
    const html = renderPhonePage("phill@b.com");
    const place = /(async function placeCall\(to\) \{[\s\S]*?\n {6}\})/.exec(html)?.[1];
    const busy = /(function callBusy\(\) \{[^\n]*\})/.exec(html)?.[1];
    if (!place || !busy) throw new Error("could not find placeCall / callBusy");
    let resolveConnect: (c: unknown) => void = () => {};
    const device = { connect: () => new Promise((r) => (resolveConnect = r)) };
    const api = new Function(
      "device",
      "document",
      `var activeCall = null, listenConnecting = false, placingCall = false;
       function onCallConnected() {} function onCallEnded() {}
       ${busy} ${place}
       return { placeCall: placeCall, callBusy: callBusy };`
    )(device, { getElementById: () => null }) as { placeCall: (to: string) => Promise<void>; callBusy: () => boolean };
    const pending = api.placeCall("+61400000000");
    expect(api.callBusy()).toBe(true);
    resolveConnect({ on() {} });
    await pending;
    expect(api.callBusy()).toBe(true);
  });
});

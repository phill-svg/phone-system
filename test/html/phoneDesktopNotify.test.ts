import { describe, expect, it, vi } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// The Electron shell raises its own native toast from the main process (main.js, ipc
// "incoming-call"). The page used to fire a web Notification as well, so a desktop user got TWO
// toasts for one call -- and the bridge was handed the raw number while the web one showed the
// contact name.
//
// The REAL emitted showIncomingBanner is pulled out of the page and run against stubs, so a
// regression in phone.ts has to reach this test.
function harness(desktop: boolean) {
  const html = renderPhonePage("phill@b.com");
  const banner = /(function showIncomingBanner\(call\) \{[\s\S]*?\n {6}\})/.exec(html)?.[1];
  if (!banner) throw new Error("could not find showIncomingBanner in the emitted phone script");

  const notifyIncomingCall = vi.fn();
  const NotificationCtor = vi.fn();
  const el = () => ({ style: {} as Record<string, string>, textContent: "" });
  const run = new Function(
    "notifyIncomingCall",
    "NotificationCtor",
    "document",
    "desktop",
    `var contactsByNorm = { '+61400000000': { name: 'Jane Customer' } };
     function normalizePhoneJS(v) { return v; }
     function formatAu(v) { return v; }
     function incomingCallerNumber() { return '+61400000000'; }
     var Notification = NotificationCtor;
     Notification.permission = 'granted';
     var window = { Notification: NotificationCtor };
     if (desktop) window.desktopBridge = { notifyIncomingCall: notifyIncomingCall };
     ${banner}
     return showIncomingBanner;`
  );
  const showIncomingBanner = run(notifyIncomingCall, NotificationCtor, { getElementById: el }, desktop) as (
    call: unknown
  ) => void;
  return { showIncomingBanner, notifyIncomingCall, NotificationCtor };
}

describe("the incoming-call toast", () => {
  it("goes to the desktop shell only, with the contact name, when the bridge is there", () => {
    const { showIncomingBanner, notifyIncomingCall, NotificationCtor } = harness(true);
    showIncomingBanner({});
    expect(notifyIncomingCall).toHaveBeenCalledWith("Jane Customer");
    expect(NotificationCtor).not.toHaveBeenCalled();
  });

  it("falls back to the web Notification in a plain browser", () => {
    const { showIncomingBanner, notifyIncomingCall, NotificationCtor } = harness(false);
    showIncomingBanner({});
    expect(notifyIncomingCall).not.toHaveBeenCalled();
    expect(NotificationCtor).toHaveBeenCalledWith("Incoming call", expect.objectContaining({ body: "Jane Customer" }));
  });
});

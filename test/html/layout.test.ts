import { describe, expect, it, vi } from "vitest";
import { escapeHtml, renderLayout } from "../../src/html/layout";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x">Bob & Jane's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Bob &amp; Jane&#39;s&lt;/a&gt;"
    );
  });
});

describe("renderLayout", () => {
  it("includes the escaped title and marks the active nav link", () => {
    const html = renderLayout("Voice <Mail>", "voicemail", "<p>body</p>");
    expect(html).toContain("Voice &lt;Mail&gt;");
    expect(html).toContain('class="nav-link active"');
    expect(html).toContain("<p>body</p>");
  });

  it("shows every nav link to an admin (default)", () => {
    const html = renderLayout("Settings", "settings", "");
    for (const href of ["/admin/settings", "/admin/phone", "/admin/messages", "/admin/live", "/admin/voicemail", "/admin/callbacks", "/admin/errors"]) {
      expect(html).toContain(href);
    }
  });

  // The handset carries the same list, so the dashboard does not repeat it.
  it("has no Call History link at all", () => {
    const html = renderLayout("Voicemail", "voicemail", "");
    expect(html).not.toContain('href="/admin/calls"');
    expect(html).not.toContain("Call History");
  });

  it("hides admin-only nav links (Settings) from staff", () => {
    const html = renderLayout("Phone", "phone", "", { role: "staff" });
    // Staff keep these
    expect(html).toContain("/admin/phone");
    expect(html).toContain("/admin/voicemail");
    expect(html).toContain("/admin/live");
    expect(html).toContain("/admin/callbacks");
    // Admin-only links are gone
    expect(html).not.toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/errors"');
  });
});

describe("desktop notification script", () => {
  const html = renderLayout("Voicemail", "voicemail", "");

  // Injected on every page as inline <script> text, so a typo here breaks notifications silently.
  function notifyJs(): string {
    const at = html.indexOf('var LS_MSG = "tcbNotifyLastMsgTs";');
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<script>", at);
    const close = html.indexOf("</script>", at);
    return html.slice(open + "<script>".length, close);
  }

  it("parses as JavaScript", () => {
    expect(() => new Function(notifyJs())).not.toThrow();
  });

  it("says which channel a message arrived on", () => {
    const js = notifyJs();
    expect(js).toContain('var fbm = String(c.number || "").indexOf("messenger:") === 0;');
    expect(js).toContain('fire(fbm ? "New Facebook message" : "New SMS"');
    // A Messenger peer has no phone number worth showing — never put a raw PSID in the toast.
    expect(js).toContain('(c.name || (fbm ? "Facebook user" : c.number))');
  });
});

// Every section opens in a frame inside the Phone page, and both carry this script. Without the
// gate every new text would be polled and toasted twice. The REAL emitted script runs against stubs.
describe("desktop notification script inside the Phone page's frame", () => {
  function runNotify(framed: boolean) {
    const html = renderLayout("Voicemail", "voicemail", "");
    const at = html.indexOf('var LS_MSG = "tcbNotifyLastMsgTs";');
    const js = html.slice(html.lastIndexOf("<script>", at) + "<script>".length, html.indexOf("</script>", at));
    const fetch = vi.fn(() => new Promise(() => {}));
    const win: Record<string, unknown> = { Notification: function () {} };
    win.top = framed ? {} : win;
    new Function("window", "Notification", "document", "localStorage", "fetch", "setInterval", js)(
      win,
      { permission: "granted" },
      { addEventListener() {} },
      { getItem: () => null, setItem() {} },
      fetch,
      () => 0
    );
    return { fetch, win };
  }

  it("stays silent inside the frame", () => {
    const { fetch, win } = runNotify(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(win.tcbNotifyPollNow).toBeUndefined();
  });

  it("still polls in the top page", () => {
    expect(runNotify(false).fetch).toHaveBeenCalledWith("/api/messages", expect.anything());
  });
});

describe("a section rendered inside the Phone page's frame", () => {
  it("hides its own header, since the Phone page's nav is already above it", () => {
    const html = renderLayout("Voicemail", "voicemail", "");
    expect(html).toContain('if (window.top !== window) document.documentElement.className += " embedded";');
    expect(html).toContain("html.embedded header { display: none; }");
  });
});

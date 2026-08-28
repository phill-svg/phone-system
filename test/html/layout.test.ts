import { describe, expect, it } from "vitest";
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
    const html = renderLayout("Call <History>", "calls", "<p>body</p>");
    expect(html).toContain("Call &lt;History&gt;");
    expect(html).toContain('class="nav-link active"');
    expect(html).toContain("<p>body</p>");
  });

  it("shows every nav link to an admin (default)", () => {
    const html = renderLayout("Settings", "settings", "");
    for (const href of ["/admin/settings", "/admin/phone", "/admin/messages", "/admin/live", "/admin/calls", "/admin/callbacks"]) {
      expect(html).toContain(href);
    }
  });

  it("hides admin-only nav links (Settings) from staff", () => {
    const html = renderLayout("Phone", "phone", "", { role: "staff" });
    // Staff keep these
    expect(html).toContain("/admin/phone");
    expect(html).toContain("/admin/calls");
    expect(html).toContain("/admin/live");
    expect(html).toContain("/admin/callbacks");
    // Admin-only links are gone
    expect(html).not.toContain('href="/admin/settings"');
  });
});

describe("desktop notification script", () => {
  const html = renderLayout("Call History", "calls", "");

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

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
});

import { describe, expect, it } from "vitest";
import { renderSettingsPage } from "../../src/html/pages/settings";

// The blocklist form's client JS lives inside a template literal, where `\n` is a REAL newline in
// the emitted script rather than the two characters a JS string needs. Writing `split('\n')`
// instead of `split('\\n')` therefore ends a string literal mid-line and breaks the whole inline
// script -- every handler on the Settings page, not just this form. It is invisible in review and
// invisible to tsc, and it happened while fixing this very form.

const CLOSED = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

function page(blocklist: string[] = ["+61400123456"]): string {
  return renderSettingsPage(
    CLOSED,
    blocklist,
    [],
    [],
    "admin",
    true,
    { enabled: false, template: "" }
  );
}

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

describe("the Settings page's inline script", () => {
  it("parses - a stray newline inside a string literal breaks every handler on the page", () => {
    const scripts = inlineScripts(page());
    expect(scripts.length).toBeGreaterThan(0);
    for (const js of scripts) {
      expect(() => new Function(js)).not.toThrow();
    }
  });

  // The textarea splits on newlines, so the emitted script must contain the two-character escape.
  it("emits an escaped newline for the blocklist split and write-back", () => {
    const js = inlineScripts(page()).join("\n");
    expect(js).toContain("split('\\n')");
    expect(js).toContain("join('\\n')");
  });

  // The server owns the rule now (handlePutCallBlocklist -> blocklistNumber). The form used to
  // normalise locally and disagree with the handset about the same text.
  it("posts the lines as typed and surfaces the server's rejection", () => {
    const js = inlineScripts(page()).join("\n");
    expect(js).toContain("/api/settings/call-blocklist");
    expect(js).toContain("body.error");
    // No local E.164 rewrite: that is what drifted from the handset and mangled note lines.
    expect(js).not.toContain("'61' + d.slice(1)");
  });
});

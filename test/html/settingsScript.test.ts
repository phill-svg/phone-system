import { describe, expect, it } from "vitest";
import { renderSettingsPage } from "../../src/html/pages/settings";

// This page's browser code lives inside a TypeScript TEMPLATE LITERAL, which means every escape in
// it is interpreted TWICE -- once by TypeScript when the page is built, once by the browser when the
// script is parsed. A `'\n'` written with ONE backslash is therefore a real newline in the emitted
// HTML, which makes an unterminated string literal, which is a SyntaxError that kills the ENTIRE
// <script> block -- not just the statement it appears in.
//
// That shipped with the on-call rotation and took the whole settings page down with it: business
// hours would not save, the blocklist would not save, phone numbers never loaded, staff schedules
// were dead and the on-call box sat on "Loading…" forever, because `loadOnCall()` is the last
// statement in the block and was never reached. Every one of those reads as a separate feature bug,
// and none of them is; there is one syntax error upstream of all of them.
//
// Nothing else catches this. It typechecks, it renders, every string assertion about the page still
// passes, and the failure only exists in a browser. So: parse what we actually emit.
const leadingArgs = [/* schedule */ {}, /* blocklist */ [], /* staffRoster */ []] as [any, any, any];

function scriptsFrom(html: string): string[] {
  const out: string[] = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

describe("the settings page's inline script", () => {
  // Both roles, because the admin-only sections are a different concatenation of the template and
  // a broken escape could live in either half.
  for (const role of ["admin", "staff"] as const) {
    it(`parses as valid JavaScript for a ${role}`, () => {
      const scripts = scriptsFrom(renderSettingsPage(...leadingArgs, [], role, true));
      expect(scripts.length).toBeGreaterThan(0);
      for (const src of scripts) {
        // Function() parses without executing -- exactly what the browser does before running any
        // of it, and the only step that was failing.
        expect(() => new Function(src)).not.toThrow();
      }
    });
  }

  // The two handlers that were dead, pinned by behaviour rather than by source text: if the block
  // stops parsing again, these disappear from the page along with everything else.
  it("wires up the handlers the syntax error was silently removing", () => {
    const html = renderSettingsPage(...leadingArgs, [], "admin", true);
    expect(html).toContain("document.getElementById('business-hours-form').addEventListener");
    expect(html).toContain("loadOnCall();");
  });
});

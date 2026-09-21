import { describe, expect, it } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";

// A customer's photo arrives as a message with an EMPTY body, so a thread that renders only text
// showed a blank bubble and nothing else. The web client JS lives in a template literal, where a
// stray unescaped quote breaks every handler on the page and tsc cannot see it.

function clientJs(): string {
  const html = renderMessagesPage("admin");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  return scripts.join("\n");
}

describe("the messages page's attachment rendering", () => {
  it("parses - a broken string literal here takes out the whole thread view", () => {
    expect(() => new Function(clientJs())).not.toThrow();
  });

  // The image is fetched from our own proxy, never Twilio directly: that url needs the account
  // credentials, and the browser has none.
  it("points images at the authenticated proxy route", () => {
    const js = clientJs();
    expect(js).toContain("/api/messages/");
    expect(js).toContain("/media/");
    expect(js).toContain("msg-media");
  });

  // Rendering a PDF or an audio note as an <img> shows a broken frame. It gets a link instead.
  it("only inlines images, and links anything else", () => {
    const js = clientJs();
    expect(js).toContain('indexOf("image/")===0');
    expect(js).toContain("msg-attach");
  });

  // The content type comes from a Twilio webhook and is spliced into HTML.
  it("escapes the content type it prints", () => {
    expect(clientJs()).toContain("esc(mm.content_type)");
  });
});

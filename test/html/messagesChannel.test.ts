import { describe, expect, it } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";

const html = renderMessagesPage();

// The page ships its client code as one inline <script> built by string concatenation, so a stray
// quote or escape breaks the whole Messages page at runtime with nothing failing at build time.
// (The layout injects scripts of its own, so anchor on this page's first statement.)
function clientJs(): string {
  const at = html.indexOf("var current = null;");
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<script>", at);
  const close = html.indexOf("</script>", at);
  return html.slice(open + "<script>".length, close);
}

describe("messages page client JS", () => {
  it("parses as JavaScript", () => {
    expect(() => new Function(clientJs())).not.toThrow();
  });
});

describe("SMS vs Messenger are told apart", () => {
  it("tags every conversation with its channel", () => {
    const js = clientJs();
    expect(js).toContain('function isMessenger(number){ return String(number==null?"":number).indexOf("messenger:")===0; }');
    // Both branches exist: a Messenger conversation is labelled, and so is an SMS one.
    expect(js).toContain('class=\\"chan chan-fb\\">Messenger<');
    expect(js).toContain('class=\\"chan chan-sms\\">SMS<');
    // The chip is rendered in the list rows and above the open thread.
    expect(js).toContain("+chanChip(c.number)+");
    expect(js).toContain('"</strong></span>"+chanChip(number)');
    expect(js).toContain('"</strong>"+chanChip(number)');
    expect(html).toContain(".chan-fb {");
    expect(html).toContain(".chan-sms {");
  });

  it("replies to a Messenger thread say so instead of offering an SMS number", () => {
    expect(clientJs()).toContain('fb.textContent="Replying via Facebook Messenger"');
  });

  it("never runs a Messenger PSID through the phone-number helpers", () => {
    const js = clientJs();
    expect(js).toContain('function label(c){ if(isMessenger(c.number)) return c.name||"Facebook user"; ');
    expect(js).toContain("var c=isMessenger(number)?null:contactsByNorm[normalizePhoneJS(number)];");
  });
});

import { describe, expect, it } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";

// A customer's photo arrives as a message with an EMPTY body, so a thread that renders only text
// showed a blank bubble and nothing else.
//
// These EVALUATE renderThread against a fake message and assert on the HTML it produces. Asserting
// that the SOURCE contains `indexOf("image/")===0` or `esc(mm.content_type)` is what this repo has
// been caught by six times: the first version of this file passed with the entire media block
// deleted (the string it looked for also appears inside a helper), and it would have passed with
// `esc()` dropped -- reintroducing HTML injection of a webhook-supplied value -- as long as a
// comment still named it.

function clientJs(): string {
  const html = renderMessagesPage("admin");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  return scripts.join("\n");
}

type FakeMessage = {
  id: string;
  direction: string;
  body: string;
  ts?: number;
  status?: string;
  media?: { idx: number; content_type: string }[];
};

// Every bubble now carries a timestamp caption, so a fixture without `ts` renders the literal
// string "Invalid Date invalid date" and every assertion below still passes -- which is exactly
// what this file was doing before the timestamps were reviewed. Defaulted here rather than on
// seven fixtures, and pinned by its own test below so the default cannot quietly rot again.
const FIXED_TS = Date.UTC(2020, 0, 15, 2, 30);

// Runs the page's own renderThread over `msgs` and returns the HTML it wrote into the scroller.
//
// The fakes are PARAMETERS rather than assignments inside the body: the page's client JS touches
// `document` as it loads (wiring handlers), so anything assigned in the body arrives too late.
function renderThread(msgs: FakeMessage[]): string {
  const scroller = { innerHTML: "", scrollTop: 0, scrollHeight: 0 };
  // The page's `esc()` escapes by round-tripping through a real element: set textContent, read
  // innerHTML. So the fake element has to do that for real, or every escaped value comes back empty
  // and the test would pass for the wrong reason. This also keeps esc() genuinely exercised --
  // delete the call and the raw value appears in the output below.
  const escapeText = (v: string) =>
    String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const node = () => ({
    _text: "" as string,
    set textContent(v: string) {
      this._text = String(v);
    },
    get textContent(): string {
      return this._text;
    },
    get innerHTML(): string {
      return escapeText(this._text);
    },
    set innerHTML(v: string) {
      this._text = String(v);
    },
    value: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild() {},
    removeAttribute() {},
    setAttribute() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const fakeDocument = {
    getElementById: (id: string) => (id === "scroll" ? scroller : node()),
    querySelector: () => node(),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => node(),
    body: node(),
    documentElement: node(),
  };
  const noop = () => 0;
  const body = `
    ${clientJs()}
    current = "+61400000000";
    renderThread(MSGS);
    return document.getElementById("scroll").innerHTML;
  `;
  return new Function(
    "MSGS",
    "document",
    "window",
    "location",
    "history",
    "fetch",
    "setInterval",
    "setTimeout",
    "localStorage",
    body
  )(
    msgs.map((m) => ({ ts: FIXED_TS, ...m })),
    fakeDocument,
    { addEventListener() {}, location: { search: "", pathname: "/admin/messages" } },
    { search: "", pathname: "/admin/messages", href: "https://tcbvoip.app/admin/messages" },
    { replaceState() {}, pushState() {} },
    () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    noop,
    noop,
    { getItem: () => null, setItem() {} }
  ) as string;
}

describe("the messages thread's attachment rendering", () => {
  it("parses - a broken string literal here takes out the whole thread view", () => {
    expect(() => new Function(clientJs())).not.toThrow();
  });

  // Renders a real date, not "Invalid Date". This is the only test that renders renderThread, so
  // without it a broken msgTime reaches the dashboard with every other assertion here still green.
  it("captions each bubble with a real time rather than Invalid Date", () => {
    const html = renderThread([{ id: "SM1", direction: "inbound", body: "hello" }]);
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("invalid date");
    expect(html).toMatch(/15 Jan\b/);
    expect(html).toMatch(/\d{1,2}:\d{2}\s?[ap]m/);
  });

  // The image is fetched from our own proxy, never Twilio directly: that url needs the account
  // credentials, and the browser has none.
  it("renders a photo as an image pointing at the authenticated proxy", () => {
    const html = renderThread([
      { id: "SM1", direction: "inbound", body: "", media: [{ idx: 0, content_type: "image/jpeg" }] },
    ]);
    expect(html).toContain('src="/api/messages/SM1/media/0"');
    expect(html).toContain("msg-media");
    expect(html).not.toContain("api.twilio.com");
  });

  // An SVG is an image to a person and a script host to a browser, and the type is chosen by
  // whoever sent the message. The server refuses to serve one inline; the client must not ask.
  it("never renders an SVG as an image", () => {
    const html = renderThread([
      { id: "SM1", direction: "inbound", body: "", media: [{ idx: 0, content_type: "image/svg+xml" }] },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("msg-attach");
  });

  // Rendering a PDF as an <img> shows a broken frame.
  it("links a non-image attachment instead of inlining it", () => {
    const html = renderThread([
      { id: "SM1", direction: "inbound", body: "", media: [{ idx: 0, content_type: "application/pdf" }] },
    ]);
    expect(html).toContain("Attachment (application/pdf)");
    expect(html).not.toContain("<img");
  });

  // The content type comes from a Twilio webhook and is spliced into HTML. Dropping esc() here is
  // stored HTML injection into the authenticated dashboard.
  it("escapes the content type it prints", () => {
    const html = renderThread([
      {
        id: "SM1",
        direction: "inbound",
        body: "",
        media: [{ idx: 0, content_type: '"><img src=x onerror=alert(1)>' }],
      },
    ]);
    // The tag is inert text, not markup: `<` and `>` are entities and the quote that would close
    // the surrounding attribute is `&quot;`. `onerror=alert(1)` still appears as characters inside
    // that escaped text, which is exactly right -- asserting on its absence would be asserting the
    // wrong thing.
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('"><img');
    expect(html).toContain("&quot;");
  });

  it("still renders the caption sent with a photo", () => {
    const html = renderThread([
      { id: "SM1", direction: "inbound", body: "rat in the roof", media: [{ idx: 0, content_type: "image/jpeg" }] },
    ]);
    expect(html).toContain("rat in the roof");
    expect(html).toContain("msg-media");
  });

  it("renders an ordinary text message with no attachment markup", () => {
    const html = renderThread([{ id: "SM1", direction: "inbound", body: "just text" }]);
    expect(html).toContain("just text");
    expect(html).not.toContain("msg-media");
    expect(html).not.toContain("msg-attach");
  });
});

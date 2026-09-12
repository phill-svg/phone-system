import { describe, expect, it } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";

const html = renderMessagesPage();

function clientJs(): string {
  const at = html.indexOf("var current = null;");
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<script>", at);
  const close = html.indexOf("</script>", at);
  return html.slice(open + "<script>".length, close);
}

// Pull the REAL emitted source out of the page and RUN it, rather than asserting on substrings.
// CLIENT_JS is `[...].join("\n")` with one statement per entry, so a function is exactly one line.
//
// This matters twice over. A substring assertion passes against a page whose script does not parse
// at all -- the single-backslash `\n` that left /admin/settings completely inert did exactly that,
// with every string assertion still green. And it passes against a rule that is subtly wrong, which
// is the other half of "a test that reads source text is not a test".
function evalFn<T>(name: string): T {
  const lines = clientJs().split("\n");
  const line = lines.find((l) => l.trimStart().startsWith(`function ${name}(`));
  expect(line, `no emitted function ${name}`).toBeTruthy();
  // SENT_STATUSES is a free variable of msgStatusLabel, so it has to be in scope with it.
  const consts = lines.filter((l) => l.trimStart().startsWith("var SENT_STATUSES=")).join("\n");
  return new Function(`${consts}\n${line}\nreturn ${name};`)() as T;
}

type Label = { text: string; failed: boolean } | null;
type LabelFn = (direction: string, status: string | null, isLastOutbound: boolean, isMessenger: boolean) => Label;
type IndexFn = (msgs: { direction: string }[]) => number;

describe("outbound message status caption (web)", () => {
  const label = evalFn<LabelFn>("msgStatusLabel");

  it("captions the last outbound SMS with its delivery state", () => {
    expect(label("outbound", "delivered", true, false)).toEqual({ text: "Delivered", failed: false });
    expect(label("outbound", "sent", true, false)).toEqual({ text: "Sent", failed: false });
    expect(label("outbound", "read", true, false)).toEqual({ text: "Read", failed: false });
  });

  it("says nothing under an inbound message", () => {
    expect(label("inbound", "delivered", true, false)).toBeNull();
    expect(label("inbound", "failed", true, false)).toBeNull();
  });

  // Repeating "Delivered" under every bubble is noise people learn to skip -- the same reason the
  // divert-caller-ID marker clears itself and the "unfinished" IVR badge is deliberately narrow.
  it("captions only the LAST outbound message, not every one", () => {
    expect(label("outbound", "delivered", false, false)).toBeNull();
    expect(label("outbound", "sent", false, false)).toBeNull();
  });

  // A text that never arrived still matters ten messages later.
  it("reports a failure wherever it sits in the thread", () => {
    expect(label("outbound", "failed", false, false)).toEqual({ text: "Not delivered", failed: true });
    expect(label("outbound", "undelivered", false, false)).toEqual({ text: "Not delivered", failed: true });
  });

  // Facebook does not report delivery back the way Twilio's status callback does, so every Messenger
  // message stops at `sent` permanently -- 13 of them in production on 2026-09-12, newest 09-04.
  // Captioning those "Sent" forever would read as "not delivered yet" and be wrong every time.
  it("never captions a Messenger message as sent or delivered", () => {
    expect(label("outbound", "sent", true, true)).toBeNull();
    expect(label("outbound", "delivered", true, true)).toBeNull();
    expect(label("outbound", "read", true, true)).toBeNull();
  });

  it("still reports a Messenger failure, which is the 24-hour-window rejection", () => {
    expect(label("outbound", "failed", false, true)).toEqual({ text: "Not delivered", failed: true });
  });

  it("says nothing for a status it does not recognise, rather than guessing 'Sent'", () => {
    expect(label("outbound", null, true, false)).toBeNull();
    expect(label("outbound", "", true, false)).toBeNull();
    expect(label("outbound", "something_twilio_added_later", true, false)).toBeNull();
  });

  it("is case- and whitespace-insensitive about the stored status", () => {
    expect(label("outbound", " Delivered ", true, false)).toEqual({ text: "Delivered", failed: false });
    expect(label("outbound", "FAILED", true, false)).toEqual({ text: "Not delivered", failed: true });
  });
});

describe("finding the last outbound message (web)", () => {
  const lastOutboundIndex = evalFn<IndexFn>("lastOutboundIndex");

  it("finds the final outbound in a thread that ends with an inbound reply", () => {
    expect(
      lastOutboundIndex([{ direction: "inbound" }, { direction: "outbound" }, { direction: "inbound" }])
    ).toBe(1);
  });

  it("returns -1 when the customer has only ever written to us", () => {
    expect(lastOutboundIndex([{ direction: "inbound" }, { direction: "inbound" }])).toBe(-1);
    expect(lastOutboundIndex([])).toBe(-1);
  });
});

describe("the thread renderer uses the rule rather than re-deriving it", () => {
  // The helper having correct behaviour proves nothing if renderThread never calls it -- the exact
  // gap that let a reverted putIvrFlow keep 164 mobile tests green. Pin the wiring, not just the rule.
  it("renders the caption through msgStatusLabel and both CSS classes", () => {
    const js = clientJs();
    expect(js).toContain("var st=msgStatusLabel(m.direction,m.status,i===lastOut,fbThread);");
    expect(js).toContain('(st.failed?"msg-status-fail":"msg-status")');
    expect(html).toContain(".msg-status {");
    expect(html).toContain(".msg-status-fail {");
  });

  it("still parses as JavaScript", () => {
    expect(() => new Function(clientJs())).not.toThrow();
  });
});

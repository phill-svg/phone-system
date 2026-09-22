import type { Message } from "../src/lib/api";

// `@testing-library/react-native` cannot run in this repo -- it resolves `test-renderer`, which does
// not exist against the installed React, and that is why auth.test.tsx sits in
// testPathIgnorePatterns. So this renders the component the other way: a function component IS a
// function, and with its one hook mocked away, calling it returns the element tree to inspect.
//
// Why bother, when messageStatusLabel already has unit tests in conversations.test.ts: those pass
// with the caption deleted from the component entirely. The handset would silently lose both the
// "Not delivered" warning and the delivery state with every mobile test green. That is the
// "testing a helper is not testing the call site" gap already recorded for putIvrFlow, the Admin
// hub's headerLeft and the IVR canvas positions.
jest.mock("../src/theme/theme", () => ({
  useTheme: () => ({ colors: { accent: "#a", fill: "#f", label: "#l", labelSecondary: "#s" } }),
  type: { body: {}, caption: {} },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MessageBubble } = require("../src/components/MessageBubble");

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  direction: "outbound",
  body: "Hello",
  ts: 1,
  status: "delivered",
  error_code: null,
  error_message: null,
  ...over,
});

// Flatten every string the element tree would render, in order.
function texts(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => texts(n, out));
    return out;
  }
  const el = node as { props?: { children?: unknown } };
  if (el.props && el.props.children !== undefined) texts(el.props.children, out);
  return out;
}

const render = (props: { message: Message; isLastOutbound: boolean; isMessenger: boolean }) =>
  texts(MessageBubble(props)).join("");

describe("MessageBubble", () => {
  it("always renders the message body", () => {
    expect(render({ message: msg(), isLastOutbound: true, isMessenger: false })).toContain("Hello");
  });

  it("captions the last outbound message with its delivery state", () => {
    expect(render({ message: msg({ status: "delivered" }), isLastOutbound: true, isMessenger: false })).toContain(
      "Delivered"
    );
    expect(render({ message: msg({ status: "sent" }), isLastOutbound: true, isMessenger: false })).toContain("Sent");
  });

  it("shows no caption on an earlier outbound message", () => {
    expect(render({ message: msg({ status: "delivered" }), isLastOutbound: false, isMessenger: false })).not.toContain(
      "Delivered"
    );
  });

  it("shows no caption on an inbound message", () => {
    expect(
      render({ message: msg({ direction: "inbound", status: "delivered" }), isLastOutbound: true, isMessenger: false })
    ).not.toContain("Delivered");
  });

  // The failure warning is the half already shipped in #17 and must not be lost.
  it("warns about a failed message wherever it sits, with the reason", () => {
    expect(
      render({
        message: msg({ status: "failed", error_message: "Outside the 24-hour window" }),
        isLastOutbound: false,
        isMessenger: false,
      })
    ).toContain("Not delivered -- Outside the 24-hour window");
  });

  it("falls back to the error code when there is no message", () => {
    expect(
      render({ message: msg({ status: "undelivered", error_code: "30007" }), isLastOutbound: true, isMessenger: false })
    ).toContain("Not delivered -- Error 30007");
  });

  // Facebook never reports delivery back, so a Messenger message sits on `sent` forever.
  it("never captions a Messenger message as sent or delivered", () => {
    expect(render({ message: msg({ status: "sent" }), isLastOutbound: true, isMessenger: true })).not.toContain("Sent");
  });

  it("still warns about a failed Messenger message", () => {
    expect(render({ message: msg({ status: "failed" }), isLastOutbound: true, isMessenger: true })).toContain(
      "Not delivered"
    );
  });

  // A stale error_code on a row that later succeeded must not be appended to "Delivered".
  it("never appends an error detail to a successful caption", () => {
    const out = render({
      message: msg({ status: "delivered", error_code: "30007", error_message: "stale" }),
      isLastOutbound: true,
      isMessenger: false,
    });
    expect(out).toContain("Delivered");
    expect(out).not.toContain("stale");
  });
});

// Attachments -- a customer's photo. Twilio carries these on the same inbound webhook, and nothing
// read them, so a photo arrived as a bubble with an EMPTY body and no sign an attachment existed.
// Walking the tree for element types (not just strings) is what pins the call site: delete the
// attachment block from the component and these fail while every other mobile test stays green.
function elementTypes(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => elementTypes(n, out));
    return out;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === "string") out.push(el.type);
  else if (typeof el.type === "function") out.push((el.type as { name?: string }).name ?? "anon");
  if (el.props && el.props.children !== undefined) elementTypes(el.props.children, out);
  return out;
}

describe("MessageBubble attachments", () => {
  const withPhoto = msg({
    direction: "inbound",
    body: "",
    media: [{ idx: 0, content_type: "image/jpeg" }],
  });

  it("renders an attachment component for a photo", () => {
    expect(elementTypes(MessageBubble({ message: withPhoto, isLastOutbound: false, isMessenger: false }))).toContain(
      "Attachment"
    );
  });

  // The body of a picture message is empty, so a bubble that renders only text was a blank one.
  it("does not render an empty text node when there is no caption", () => {
    const rendered = render({ message: withPhoto, isLastOutbound: false, isMessenger: false });
    expect(rendered).toBe("");
  });

  it("still renders the caption a customer sent with the photo", () => {
    const captioned = msg({ direction: "inbound", body: "rat in the roof", media: [{ idx: 0, content_type: "image/jpeg" }] });
    expect(render({ message: captioned, isLastOutbound: false, isMessenger: false })).toContain("rat in the roof");
  });

  it("renders nothing extra for a message with no attachments", () => {
    expect(elementTypes(MessageBubble({ message: msg(), isLastOutbound: true, isMessenger: false }))).not.toContain(
      "Attachment"
    );
  });
});

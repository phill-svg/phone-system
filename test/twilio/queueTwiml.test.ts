import { describe, expect, it } from "vitest";
import type { FlowCommand } from "../../src/ivr/flowEngine";
import {
  HOLD_RINGBACK_LOOPS,
  renderCallbackAck,
  renderEnqueue,
  renderHold,
  renderLeave,
} from "../../src/twilio/queueTwiml";

describe("renderEnqueue", () => {
  it("renders a complete <Enqueue> document with waitUrl/action and the queue name inside", () => {
    const xml = renderEnqueue({
      queueName: "queue-CA-abc",
      waitUrl: "https://x.example/webhooks/twilio/hold",
      actionUrl: "https://x.example/webhooks/twilio/queue-left",
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Enqueue waitUrl="https://x.example/webhooks/twilio/hold" waitUrlMethod="POST" ' +
        'action="https://x.example/webhooks/twilio/queue-left" method="POST">queue-CA-abc</Enqueue>' +
        "</Response>"
    );
  });

  it("XML-escapes the queue name", () => {
    const xml = renderEnqueue({
      queueName: 'q&<>"\'',
      waitUrl: "https://x.example/hold",
      actionUrl: "https://x.example/left",
    });
    expect(xml).toContain(">q&amp;&lt;&gt;&quot;&apos;</Enqueue>");
  });
});

describe("renderHold", () => {
  it("wraps a real PLAY (Say) command inside the <Gather>", () => {
    const play: FlowCommand = { type: "PLAY", audioAssetId: null, ttsText: "Please hold" };
    const xml = renderHold({
      play,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/webhooks/twilio/hold-digit",
      timeoutSeconds: 30,
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Gather input="dtmf" numDigits="1" timeout="30" actionOnEmptyResult="true" ' +
        'action="https://x.example/webhooks/twilio/hold-digit"><Say>Please hold</Say></Gather>' +
        "</Response>"
    );
  });

  it("wraps a real PLAY (Play/audio) command inside the <Gather>", () => {
    const play: FlowCommand = { type: "PLAY", audioAssetId: "asset-1", ttsText: null };
    const xml = renderHold({
      play,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/hold-digit",
      timeoutSeconds: 15,
    });
    expect(xml).toContain("<Play>https://x.example/media/asset-1</Play>");
    expect(xml).toContain('timeout="15"');
  });

  it("falls back to a bare ringback tone (not music/silence, and no <Gather>) when play is null", () => {
    const xml = renderHold({
      play: null,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/hold-digit",
      timeoutSeconds: 10,
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Play loop="${HOLD_RINGBACK_LOOPS}">https://tcbvoip.app/media/system/ringback-au.wav</Play>` +
        "</Response>"
    );
  });

  // The <Gather>'s trailing `timeout` is silence appended AFTER the tone, so on the plain-ringback
  // path it lands inside the ring cadence and stretches the gap between rings -- the caller hears
  // ring, short gap, ring, long gap, which does not sound like a phone ringing. Nothing needs the
  // <Gather> there (a direct ring never allows *), so it must not be emitted.
  it("does not wrap the plain ringback in a <Gather>, whose timeout would distort the ring cadence", () => {
    const xml = renderHold({
      play: null,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/hold-digit",
      timeoutSeconds: 10,
    });
    expect(xml).not.toContain("<Gather");
    expect(xml).not.toContain("timeout=");
  });

  // ...but a wait node that DOES offer * still needs the Gather, even with no custom hold content.
  it("keeps the <Gather> around the ringback when the caller may press * for a callback", () => {
    const xml = renderHold({
      play: null,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/hold-digit",
      timeoutSeconds: 10,
      allowStar: true,
    });
    expect(xml).toContain('<Gather input="dtmf" numDigits="1" timeout="10"');
    expect(xml).toContain(`<Play loop="${HOLD_RINGBACK_LOOPS}">`);
  });

  // Regression guard for the "caller rings forever and never reaches the menu" bug.
  //
  // The hold document doubles as the queue's poll: Twilio re-fetches waitUrl / fires the <Gather>
  // action only once the document ENDS, and that is the ONLY way CallSession can hand the caller a
  // <Leave/> and move them on to the no-answer branch. A <Play loop="0"> repeats until hangup, so
  // it makes the document infinite and strands the caller on ringback no matter what the ring plan
  // decided. Shipping that is what broke the live line, so assert it can never come back.
  it("never emits an unbounded ringback loop -- the hold document must terminate so the queue re-polls", () => {
    for (const allowStar of [false, true]) {
      const xml = renderHold({
        play: null,
        baseUrl: "https://x.example",
        gatherAction: "https://x.example/hold-digit",
        timeoutSeconds: 10,
        allowStar,
      });
      expect(xml).not.toContain('loop="0"');
      expect(xml).toContain(`<Play loop="${HOLD_RINGBACK_LOOPS}">`);
    }
    expect(HOLD_RINGBACK_LOOPS).toBeGreaterThan(0);
    expect(Number.isInteger(HOLD_RINGBACK_LOOPS)).toBe(true);
  });

  // The tone must be the Australian one. The file it replaced was Twilio's US SDK asset (a single
  // 440 Hz burst), which callers reported did not sound like a phone ringing. The URL is also
  // versioned by NAME because /media/* is served immutable for a year -- reusing a filename would
  // keep the old audio in Twilio's and Cloudflare's caches for months.
  it("points at the Australian ringback asset, by a versioned filename", () => {
    const xml = renderHold({
      play: null,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/hold-digit",
      timeoutSeconds: 10,
    });
    expect(xml).toContain("https://tcbvoip.app/media/system/ringback-au.wav");
    expect(xml).not.toContain("ringback.mp3");
  });
});

describe("renderLeave", () => {
  it("renders <Leave/> wrapped in a Response", () => {
    expect(renderLeave()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Leave/></Response>'
    );
  });
});

describe("renderCallbackAck", () => {
  it("renders a Say + Hangup document", () => {
    expect(renderCallbackAck("Thanks, we'll call you back.")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        "<Say>Thanks, we&apos;ll call you back.</Say><Hangup/>" +
        "</Response>"
    );
  });

  it("XML-escapes the message", () => {
    const xml = renderCallbackAck('A & B < C > D "E"');
    expect(xml).toContain("<Say>A &amp; B &lt; C &gt; D &quot;E&quot;</Say>");
  });
});

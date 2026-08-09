import { describe, expect, it } from "vitest";
import type { FlowCommand } from "../../src/ivr/flowEngine";
import {
  renderCallbackAck,
  renderDialIntoQueue,
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

  it("renders an empty <Gather> when play is null", () => {
    const xml = renderHold({
      play: null,
      baseUrl: "https://x.example",
      gatherAction: "https://x.example/hold-digit",
      timeoutSeconds: 10,
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Gather input="dtmf" numDigits="1" timeout="10" actionOnEmptyResult="true" ' +
        'action="https://x.example/hold-digit"></Gather>' +
        "</Response>"
    );
  });
});

describe("renderLeave", () => {
  it("renders <Leave/> wrapped in a Response", () => {
    expect(renderLeave()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Leave/></Response>'
    );
  });
});

describe("renderDialIntoQueue", () => {
  it("renders the agent-leg <Dial><Queue> with dual recording and callbacks", () => {
    const xml = renderDialIntoQueue({
      queueName: "queue-CA-abc",
      actionUrl: "https://x.example/webhooks/twilio/agent-status?callSid=CA-abc",
      recordingStatusCallbackUrl: "https://x.example/webhooks/twilio/recording-status?callSid=CA-abc",
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Dial action="https://x.example/webhooks/twilio/agent-status?callSid=CA-abc" method="POST" ' +
        'record="record-from-answer-dual" ' +
        'recordingStatusCallback="https://x.example/webhooks/twilio/recording-status?callSid=CA-abc" ' +
        'recordingStatusCallbackMethod="POST">' +
        "<Queue>queue-CA-abc</Queue>" +
        "</Dial>" +
        "</Response>"
    );
  });

  it("XML-escapes the queue name", () => {
    const xml = renderDialIntoQueue({
      queueName: "q&<'",
      actionUrl: "https://x.example/a",
      recordingStatusCallbackUrl: "https://x.example/r",
    });
    expect(xml).toContain("<Queue>q&amp;&lt;&apos;</Queue>");
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

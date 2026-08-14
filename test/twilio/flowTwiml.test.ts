import { describe, expect, it } from "vitest";
import { renderFlowCommandsFragment, wrapResponse, renderFlowTwiml } from "../../src/twilio/flowTwiml";
import type { FlowCommand } from "../../src/ivr/flowEngine";

const BASE_URL = "https://example.com";

describe("flowTwiml", () => {
  describe("renderFlowCommandsFragment", () => {
    it("renders a PLAY command with ttsText as <Say>", () => {
      const commands: FlowCommand[] = [{ type: "PLAY", audioAssetId: null, ttsText: "Hello there" }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("<Say>Hello there</Say>");
    });

    it("renders a PLAY command with audioAssetId as <Play> with full media URL", () => {
      const commands: FlowCommand[] = [{ type: "PLAY", audioAssetId: "audio-123", ttsText: null }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("<Play>https://example.com/media/audio-123</Play>");
    });

    it("renders a GATHER command as <Gather> with no nested prompt", () => {
      const commands: FlowCommand[] = [
        {
          type: "GATHER",
          numDigits: 1,
          timeoutSeconds: 8,
          validDigits: "123",
          action: "https://example.com/gather",
        },
      ];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe(
        '<Gather action="https://example.com/gather" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true"></Gather>'
      );
    });

    it("renders ENQUEUE as empty string", () => {
      const commands: FlowCommand[] = [{ type: "ENQUEUE" }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("");
    });

    it("renders DIAL_HANDOFF as empty string", () => {
      const commands: FlowCommand[] = [{ type: "DIAL_HANDOFF" }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("");
    });

    it("renders VOICEMAIL_HANDOFF as empty string", () => {
      const commands: FlowCommand[] = [{ type: "VOICEMAIL_HANDOFF" }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("");
    });

    it("renders HANGUP as empty string", () => {
      const commands: FlowCommand[] = [{ type: "HANGUP" }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("");
    });

    it("renders an INPUT command as a multi-digit <Gather> with finishOnKey", () => {
      const commands: FlowCommand[] = [
        { type: "INPUT", numDigits: 6, finishOnKey: "#", timeoutSeconds: 8, action: "https://example.com/webhooks/twilio" },
      ];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe(
        '<Gather action="https://example.com/webhooks/twilio" method="POST" input="dtmf" ' +
          'numDigits="6" finishOnKey="#" timeout="8" actionOnEmptyResult="true"></Gather>'
      );
    });

    it("renders a REDIRECT command as a <Dial> to the external number", () => {
      const commands: FlowCommand[] = [{ type: "REDIRECT", number: "+61212345678" }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("<Dial>+61212345678</Dial>");
    });

    it("XML-escapes special characters in ttsText", () => {
      const commands: FlowCommand[] = [
        { type: "PLAY", audioAssetId: null, ttsText: `Bob & Jane's <shop> "special"` },
      ];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe("<Say>Bob &amp; Jane&apos;s &lt;shop&gt; &quot;special&quot;</Say>");
    });

    it("XML-escapes special characters in action URL", () => {
      const commands: FlowCommand[] = [
        {
          type: "GATHER",
          numDigits: 1,
          timeoutSeconds: 8,
          validDigits: "123",
          action: `https://example.com/gather?foo=bar&baz="qux"`,
        },
      ];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toContain('action="https://example.com/gather?foo=bar&amp;baz=&quot;qux&quot;"');
    });

    it("combines multiple commands in order without nesting prompt inside gather", () => {
      const commands: FlowCommand[] = [
        { type: "PLAY", audioAssetId: null, ttsText: "Press 1 for sales" },
        {
          type: "GATHER",
          numDigits: 1,
          timeoutSeconds: 8,
          validDigits: "1",
          action: "https://example.com/gather",
        },
      ];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      expect(fragment).toBe(
        "<Say>Press 1 for sales</Say>" +
          '<Gather action="https://example.com/gather" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true"></Gather>'
      );
    });

    it("handles baseUrl with different origins", () => {
      const commands: FlowCommand[] = [{ type: "PLAY", audioAssetId: "media-456", ttsText: null }];
      const fragment = renderFlowCommandsFragment(commands, { baseUrl: "https://custom-domain.io:8080" });
      expect(fragment).toBe("<Play>https://custom-domain.io:8080/media/media-456</Play>");
    });

    it("throws error when PLAY has both audioAssetId and ttsText set", () => {
      const commands: FlowCommand[] = [
        { type: "PLAY", audioAssetId: "audio-123", ttsText: "Hello" } as any,
      ];
      expect(() => {
        renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      }).toThrow("Invalid PLAY command: both audioAssetId and ttsText are set");
    });

    it("throws error when PLAY has both audioAssetId and ttsText null", () => {
      const commands: FlowCommand[] = [{ type: "PLAY", audioAssetId: null, ttsText: null }];
      expect(() => {
        renderFlowCommandsFragment(commands, { baseUrl: BASE_URL });
      }).toThrow("Invalid PLAY command: both audioAssetId and ttsText are null");
    });
  });

  describe("wrapResponse", () => {
    it("wraps a fragment in XML declaration and Response tags", () => {
      const body = "<Say>Hello</Say>";
      const xml = wrapResponse(body);
      expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello</Say></Response>');
    });

    it("wraps an empty fragment", () => {
      const xml = wrapResponse("");
      expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    it("wraps a complex fragment with multiple verbs", () => {
      const body =
        "<Say>Welcome</Say>" +
        '<Gather action="https://example.com/gather" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true"></Gather>';
      const xml = wrapResponse(body);
      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          body +
          "</Response>"
      );
    });
  });

  describe("renderFlowTwiml", () => {
    it("renders complete TwiML response with multiple commands", () => {
      const commands: FlowCommand[] = [
        { type: "PLAY", audioAssetId: null, ttsText: "Thank you for calling" },
        { type: "PLAY", audioAssetId: null, ttsText: "Press 1 for support or 2 for sales" },
        {
          type: "GATHER",
          numDigits: 1,
          timeoutSeconds: 8,
          validDigits: "12",
          action: "https://example.com/gather",
        },
      ];
      const xml = renderFlowTwiml(commands, { baseUrl: BASE_URL });
      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          "<Say>Thank you for calling</Say>" +
          "<Say>Press 1 for support or 2 for sales</Say>" +
          '<Gather action="https://example.com/gather" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true"></Gather>' +
          "</Response>"
      );
    });

    it("renders a PLAY with audio asset in a complete response", () => {
      const commands: FlowCommand[] = [{ type: "PLAY", audioAssetId: "welcome-mp3", ttsText: null }];
      const xml = renderFlowTwiml(commands, { baseUrl: BASE_URL });
      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Play>https://example.com/media/welcome-mp3</Play></Response>'
      );
    });

    it("renders empty commands as empty Response", () => {
      const commands: FlowCommand[] = [];
      const xml = renderFlowTwiml(commands, { baseUrl: BASE_URL });
      expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    it("renders commands with only handoff types (empty output)", () => {
      const commands: FlowCommand[] = [
        { type: "ENQUEUE" },
        { type: "DIAL_HANDOFF" },
        { type: "VOICEMAIL_HANDOFF" },
      ];
      const xml = renderFlowTwiml(commands, { baseUrl: BASE_URL });
      expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    it("produces well-formed XML for complex scenario", () => {
      const commands: FlowCommand[] = [
        { type: "PLAY", audioAssetId: null, ttsText: "This call may be recorded" },
        {
          type: "GATHER",
          numDigits: 1,
          timeoutSeconds: 10,
          validDigits: "123",
          action: "https://example.com/route",
        },
        { type: "ENQUEUE" },
      ];
      const xml = renderFlowTwiml(commands, { baseUrl: "https://api.example.com" });

      // Basic structure checks for well-formed XML
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(xml).toContain("<Response>");
      expect(xml).toContain("</Response>");
      expect(xml).toContain("<Say>This call may be recorded</Say>");
      expect(xml).toContain('<Gather action="https://example.com/route"');
      // ENQUEUE renders to nothing
      expect(xml.endsWith("</Response>")).toBe(true);
    });
  });
});

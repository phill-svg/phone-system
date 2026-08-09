import type { FlowCommand } from "../ivr/flowEngine";

export type FlowTwimlOptions = {
  baseUrl: string;
};

/**
 * Escapes XML special characters. Used for text content in TwiML elements
 * like <Say>, attributes, and URLs.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Renders a single FlowCommand to its TwiML fragment.
 *
 * Rendering rules:
 * - PLAY with audioAssetId: <Play>{mediaUrl}</Play> where mediaUrl is baseUrl/media/{audioAssetId}
 * - PLAY with ttsText: <Say>{escapeXml(ttsText)}</Say>
 * - PLAY with both null or both set: throws error (defensive)
 * - GATHER: <Gather> verb with attributes, NO nested prompt (prompt is a separate PLAY command)
 * - ENQUEUE, DIAL_HANDOFF, VOICEMAIL_HANDOFF, HANGUP: empty string (handled by Part B/C's own TwiML)
 */
function renderCommand(command: FlowCommand, opts: FlowTwimlOptions): string {
  switch (command.type) {
    case "PLAY": {
      const hasAudioAsset = command.audioAssetId !== null;
      const hasTtsText = command.ttsText !== null;

      if (hasAudioAsset && hasTtsText) {
        throw new Error(
          "Invalid PLAY command: both audioAssetId and ttsText are set; exactly one should be non-null"
        );
      }

      if (!hasAudioAsset && !hasTtsText) {
        throw new Error(
          "Invalid PLAY command: both audioAssetId and ttsText are null; exactly one should be set"
        );
      }

      if (hasAudioAsset) {
        // At this point, audioAssetId is guaranteed to be non-null by the checks above
        const audioAssetId = command.audioAssetId as string;
        const mediaUrl = `${opts.baseUrl}/media/${audioAssetId}`;
        return `<Play>${escapeXml(mediaUrl)}</Play>`;
      }

      // hasTtsText - at this point ttsText is guaranteed to be non-null
      const ttsText = command.ttsText as string;
      return `<Say>${escapeXml(ttsText)}</Say>`;
    }

    case "GATHER":
      return (
        `<Gather action="${escapeXml(command.action)}" method="POST" input="dtmf" ` +
        `numDigits="${command.numDigits}" timeout="${command.timeoutSeconds}" actionOnEmptyResult="true"></Gather>`
      );

    case "ENQUEUE":
      // Handled by Part B's own TwiML rendering logic
      return "";

    case "DIAL_HANDOFF":
      // Handled by Part B's own TwiML rendering logic
      return "";

    case "VOICEMAIL_HANDOFF":
      // Handled by Part B's own TwiML rendering logic
      return "";

    case "HANGUP":
      // Handled by Part C's own TwiML rendering logic (not rendered here per brief scoping)
      return "";
  }
}

/**
 * Renders an array of FlowCommand values to a TwiML fragment (without XML declaration or Response wrapper).
 * Used to build the body of a <Response>, which can then be wrapped with wrapResponse().
 */
export function renderFlowCommandsFragment(commands: FlowCommand[], opts: FlowTwimlOptions): string {
  return commands.map((command) => renderCommand(command, opts)).join("");
}

/**
 * Wraps a TwiML fragment in XML declaration and <Response> tags.
 */
export function wrapResponse(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/**
 * Convenience function: renders FlowCommand values and wraps them in a complete TwiML response.
 */
export function renderFlowTwiml(commands: FlowCommand[], opts: FlowTwimlOptions): string {
  const body = renderFlowCommandsFragment(commands, opts);
  return wrapResponse(body);
}

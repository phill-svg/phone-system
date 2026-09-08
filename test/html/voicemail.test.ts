import { describe, expect, it } from "vitest";
import { renderVoicemailPage } from "../../src/html/pages/voicemail";
import type { CallSummary } from "../../src/db/calls";

function call(overrides: Partial<CallSummary> = {}): CallSummary {
  return {
    id: "CA-1",
    caller_number: "+61400123456",
    called_number: "+61261059771",
    started_at: 1_757_000_000_000,
    ended_at: null,
    ivr_path: null,
    is_after_hours: 0,
    status: "completed",
    recording_url: null,
    recording_sid: null,
    recording_duration: 42,
    direction: "inbound",
    mailbox_label: "General",
    transcription: null,
    call_transcript: null,
    disposition: null,
    notes: null,
    ...overrides,
  };
}

describe("html/pages/voicemail", () => {
  it("wires each row's play button and save link to the recording proxy", () => {
    const html = renderVoicemailPage([call()], new Map(), "admin");
    expect(html).toContain('class="vm-play" data-src="/api/calls/CA-1/recording"');
    expect(html).toContain('href="/api/calls/CA-1/recording" download=');
  });

  // Six stacked native players is a wall of chrome, each preloading its own connection -- and one
  // shared element is what makes starting a second message stop the first.
  it("uses a single shared audio element, not one per row", () => {
    const html = renderVoicemailPage([call({ id: "CA-1" }), call({ id: "CA-2" })], new Map(), "admin");
    expect(html.match(/<audio/g)).toHaveLength(1);
    expect(html.match(/class="vm-play"/g)).toHaveLength(2);
  });

  it("shows the recorded length, and nothing at all when Twilio never reported one", () => {
    expect(renderVoicemailPage([call({ recording_duration: 95 })], new Map(), "admin")).toContain("1:35");
    expect(renderVoicemailPage([call({ recording_duration: null })], new Map(), "admin")).not.toContain("NaN");
  });

  it("shows the contact name when one is known, and the number either way", () => {
    const named = renderVoicemailPage([call()], new Map([["+61400123456", "Sue Dunkley"]]), "admin");
    expect(named).toContain("Sue Dunkley");
    expect(named).toContain("0400 123 456");

    const anon = renderVoicemailPage([call()], new Map(), "admin");
    expect(anon).not.toContain("Sue Dunkley");
    expect(anon).toContain("0400 123 456");
  });

  it("escapes a transcript rather than letting it inject markup", () => {
    const html = renderVoicemailPage(
      [call({ transcription: '<img src=x onerror="alert(1)">' })],
      new Map(),
      "admin"
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("says so when there are no voicemails", () => {
    expect(renderVoicemailPage([], new Map(), "admin")).toContain("No voicemails yet.");
  });

  it("labels a message with no transcript rather than leaving the cell blank", () => {
    expect(renderVoicemailPage([call({ transcription: null })], new Map(), "admin")).toContain("No transcript");
  });

  it("marks Voicemail as the active nav item", () => {
    const html = renderVoicemailPage([], new Map(), "staff");
    expect(html).toContain('<a href="/admin/voicemail" class="nav-link active">Voicemail</a>');
  });
});

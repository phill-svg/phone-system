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
  it("renders a player and a download link pointing at the recording proxy", () => {
    const html = renderVoicemailPage([call()], new Map(), "admin");
    expect(html).toContain('<audio controls preload="none" src="/api/calls/CA-1/recording">');
    expect(html).toContain('href="/api/calls/CA-1/recording" download=');
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

  it("marks Voicemail as the active nav item", () => {
    const html = renderVoicemailPage([], new Map(), "staff");
    expect(html).toContain('<a href="/admin/voicemail" class="nav-link active">Voicemail</a>');
  });
});

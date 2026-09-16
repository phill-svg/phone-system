import { describe, expect, it } from "vitest";
import { renderCallDetailPage } from "../../src/html/pages/callDetail";
import type { CallSummary, CallEventRow } from "../../src/db/calls";

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
    recording_duration: null,
    direction: "inbound",
    mailbox_label: null,
    transcription: null,
    call_transcript: null,
    disposition: null,
    notes: null,
    ...overrides,
  };
}

const noEvents: CallEventRow[] = [];

describe("html/pages/callDetail", () => {
  // Reported live: a real 141s conversation had no recording at all (a dropped recording-status
  // callback), and there was no way to do anything about it from the page short of a developer
  // console -- the whole point of the recovery button.
  it("shows the recovery button for an admin when there is no recording", () => {
    const html = renderCallDetailPage(call({ id: "CA-lost" }), noEvents, "admin");
    expect(html).toContain('data-call-id="CA-lost"');
    expect(html).toContain("recoverRecording(this)");
    expect(html).toContain("Check Twilio for it");
  });

  it("does not show the button once a recording exists", () => {
    const html = renderCallDetailPage(call({ recording_sid: "RE123", recording_url: "https://x" }), noEvents, "admin");
    expect(html).not.toContain("recoverRecording");
    expect(html).toContain("/api/calls/CA-1/recording");
  });

  // The recovery endpoint is admin-only; offering the button to plain staff would 403 on click.
  it("does not show the button to a non-admin", () => {
    const html = renderCallDetailPage(call(), noEvents, "staff");
    expect(html).not.toContain("recoverRecording");
  });

  it("escapes the call id in the button's data attribute", () => {
    const html = renderCallDetailPage(call({ id: 'CA"><script>alert(1)</script>' }), noEvents, "admin");
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain("&quot;");
  });
});

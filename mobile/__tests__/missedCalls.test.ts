/// <reference types="jest" />

import type { Call } from "../src/lib/api";
// The real rule, not a copy of it -- a mirrored copy here would keep passing after the screen's
// own version drifted.
import { isMissed } from "../src/app/(tabs)/recents";

const call = (o: Partial<Call> = {}): Call =>
  ({
    id: "CA-1",
    caller_number: "+61400000000",
    called_number: "+61261059771",
    started_at: 1_757_000_000_000,
    ended_at: null,
    status: "completed",
    direction: "inbound",
    recording_sid: null,
    recording_url: null,
    recording_duration: null,
    answered: 0,
    event_count: 5,
    mailbox_label: null,
    transcription: null,
    call_transcript: null,
    disposition: null,
    notes: null,
    ...o,
  }) as Call;

describe("what counts as a missed call in Recents", () => {
  // The case the old status-string rule got wrong, and the reason nothing ever showed red: Twilio
  // reports a rang-out voicemail as `completed`, exactly like a real conversation.
  it("counts a call that rang out to voicemail, which Twilio marks completed", () => {
    expect(isMissed(call({ status: "completed", answered: 0 }))).toBe(true);
  });

  it("does not count a call somebody actually answered", () => {
    expect(isMissed(call({ status: "completed", answered: 1 }))).toBe(false);
  });

  it("never counts an outbound call, answered or not", () => {
    expect(isMissed(call({ direction: "outbound", answered: 0 }))).toBe(false);
  });

  // A call still ringing has no `answered` event YET. Marking it missed while the phone is in your
  // hand is worse than saying nothing.
  it("does not count a call that is still in progress", () => {
    expect(isMissed(call({ status: "in_progress", answered: 0 }))).toBe(false);
  });

  // No timeline means "unknown", not "nobody answered" -- otherwise every row predating the event
  // log turns red at once.
  it("falls back to the status text when there is no event timeline", () => {
    expect(isMissed(call({ event_count: 0, status: "no_answer" }))).toBe(true);
    expect(isMissed(call({ event_count: 0, status: "completed" }))).toBe(false);
  });
});

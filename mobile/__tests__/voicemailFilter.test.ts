/// <reference types="jest" />

import type { Call } from "../src/lib/api";

// The Inbox used to filter on `transcription`, which quietly hid every voicemail Whisper produced
// nothing for. Short messages -- "it's Dave, call me" -- routinely transcribe to silence, and those
// vanished from the app while sitting playable in the database the whole time. The rule under test
// is the corrected one: a voicemail is a call that landed in a MAILBOX.
function isVoicemail(c: Pick<Call, "mailbox_label">): boolean {
  return c.mailbox_label !== null && c.mailbox_label.trim() !== "";
}

describe("what counts as a voicemail in the Inbox", () => {
  it("includes a message with no transcript, which is the case that was being lost", () => {
    expect(isVoicemail({ mailbox_label: "Voicemail during hours" })).toBe(true);
  });

  it("excludes an ordinary answered call, even a recorded one", () => {
    expect(isVoicemail({ mailbox_label: null })).toBe(false);
  });

  it("excludes an empty label, which is not a mailbox", () => {
    expect(isVoicemail({ mailbox_label: "" })).toBe(false);
    expect(isVoicemail({ mailbox_label: "   " })).toBe(false);
  });
});

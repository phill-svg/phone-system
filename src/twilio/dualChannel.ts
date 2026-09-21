// Whether a recording-status callback describes a TWO-CHANNEL recording, which is the only kind
// that can be labelled by speaker: the split in `src/audio/wav.ts` needs one channel per party.
//
// Both spellings are accepted deliberately. Twilio documents `RecordingChannels` as mono/dual when
// CREATING a recording and as 1/2 on the status callback, and gating the whole feature on guessing
// which one arrives is not a bet worth taking.
export function isDualChannelRecording(recordingChannels: string | undefined | null): boolean {
  const v = (recordingChannels ?? "").trim().toLowerCase();
  return v === "2" || v === "dual";
}

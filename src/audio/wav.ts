// Splitting a two-channel Twilio recording into one file per speaker.
//
// This is what makes a transcript say WHO SAID WHAT without Twilio's Conversational Intelligence,
// which cannot be used here at all: Twilio's own regional availability page lists Conversation
// Intelligence (classic) as unsupported in AU1, regions "operate in isolation", and our landline is
// au1 -- so `intelligence.twilio.com` (US1) answers every request about an au1 recording with
// `400 Resource RE... not found` (error 95122). The one transcript it ever accepted was a call to
// the us1 number. Splitting the audio ourselves and running each channel through Workers AI
// (already wired up, already paid for) sidesteps the region entirely, and keeps the recording
// inside the worker -- the documented alternative is handing Twilio a PUBLIC media_url, i.e. a
// customer's call audio reachable from the internet.
//
// Twilio serves the two-channel file at `.wav?RequestedChannels=2`. Channel 1 is the leg that ran
// the <Dial>, which every recorded flow here makes the customer's leg except call-via-mobile --
// hence `calls.transcript_staff_channel`, written by the leg that chose the recording.
//
// Uncompressed PCM, so the "split" is arithmetic on interleaved samples rather than decoding: no
// audio library, no dependency, nothing to keep up to date.

export type StereoSplit = { left: Uint8Array; right: Uint8Array };

// Big enough for a long conversation, small enough that two copies plus their base64 encodings
// cannot exhaust a Worker's 128 MB. 25 MB of 8 kHz 16-bit stereo is a little over 13 minutes; past
// that the caller keeps the ordinary unlabelled transcript, which is strictly better than an
// out-of-memory failure that loses the transcript altogether.
//
// Enforced by the CALLER, before the body is buffered -- checking it here would be after the
// allocation it exists to prevent, and would report a deliberate refusal as a parse failure.
export const MAX_SPLIT_BYTES = 25 * 1024 * 1024;

const RIFF = 0x46464952; // "RIFF", little-endian
const WAVE = 0x45564157; // "WAVE"
const FMT = 0x20746d66; // "fmt "
const DATA = 0x61746164; // "data"
const PCM = 1;

// A mono 16-bit PCM header for `samples`, matching the source's rate.
function monoWav(samples: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, RIFF, true);
  view.setUint32(4, 36 + samples.length, true);
  view.setUint32(8, WAVE, true);
  view.setUint32(12, FMT, true);
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, PCM, true);
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true);
  view.setUint32(36, DATA, true);
  view.setUint32(40, samples.length, true);
  out.set(samples, 44);
  return out;
}

// Returns null for anything this cannot split with certainty -- not 16-bit PCM, not two channels,
// or headers that do not parse. Null means "keep the unlabelled transcript", never "no transcript":
// guessing at a format would produce confident nonsense attributed to a named speaker.
//
// 16-bit only, which is what Twilio serves. A general WAV reader here would be code written for a
// file this never receives.
export function splitStereoWav(bytes: Uint8Array): StereoSplit | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WAVE) return null;

  // Walk the chunks rather than assuming the canonical 44-byte header: Twilio is not the only thing
  // that has ever written a WAV, and a `LIST`/`fact` chunk before `data` would otherwise put the
  // split one chunk out and produce two files of noise.
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === FMT) {
      if (body + 16 > bytes.length) return null;
      if (view.getUint16(body, true) !== PCM) return null; // compressed: not ours to decode
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === DATA) {
      dataStart = body;
      // A truncated file reports more than it carries; take what is actually there.
      dataLength = Math.min(size, bytes.length - body);
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (channels !== 2 || bitsPerSample !== 16 || sampleRate <= 0) return null;
  if (dataStart < 0 || dataLength <= 0) return null;

  const frames = Math.floor(dataLength / 4); // two channels, two bytes each
  if (frames === 0) return null;

  const left = new Uint8Array(frames * 2);
  const right = new Uint8Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const src = dataStart + i * 4;
    left[i * 2] = bytes[src];
    left[i * 2 + 1] = bytes[src + 1];
    right[i * 2] = bytes[src + 2];
    right[i * 2 + 1] = bytes[src + 3];
  }
  return { left: monoWav(left, sampleRate), right: monoWav(right, sampleRate) };
}

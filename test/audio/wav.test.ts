import { describe, expect, it } from "vitest";
import { MAX_SPLIT_BYTES, splitStereoWav } from "../../src/audio/wav";

// A PCM WAV built the way Twilio serves one, so the test exercises the real parse rather than a
// shape invented to match the parser.
function wav(opts: {
  channels: number;
  bitsPerSample?: number;
  sampleRate?: number;
  samples: number[][]; // one array per channel, values already in sample units
  format?: number;
  extraChunk?: boolean;
  dataSizeOverride?: number;
}): Uint8Array {
  const bits = opts.bitsPerSample ?? 16;
  const rate = opts.sampleRate ?? 8000;
  const bytesPerSample = bits / 8;
  const frames = opts.samples[0].length;
  const dataBytes = frames * opts.channels * bytesPerSample;
  const extra = opts.extraChunk ? 12 : 0; // a LIST chunk ahead of `data`
  const out = new Uint8Array(44 + extra + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, opts.format ?? 1, true);
  view.setUint16(22, opts.channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * bytesPerSample * opts.channels, true);
  view.setUint16(32, bytesPerSample * opts.channels, true);
  view.setUint16(34, bits, true);
  let offset = 36;
  if (opts.extraChunk) {
    ascii(offset, "LIST");
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, 0, true);
    offset += 12;
  }
  ascii(offset, "data");
  view.setUint32(offset + 4, opts.dataSizeOverride ?? dataBytes, true);
  offset += 8;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < opts.channels; c++) {
      const value = opts.samples[c][f];
      if (bits === 16) view.setInt16(offset, value, true);
      else view.setUint8(offset, value);
      offset += bytesPerSample;
    }
  }
  return out;
}

function samplesOf(mono: Uint8Array): number[] {
  const view = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
  const out: number[] = [];
  for (let i = 44; i + 1 < mono.length; i += 2) out.push(view.getInt16(i, true));
  return out;
}

describe("splitStereoWav", () => {
  // The whole point: channel 1 and channel 2 come back as separate audio, in order, unmixed. If the
  // de-interleave were off by one sample every transcript would be noise attributed to a speaker.
  it("separates the two channels sample for sample", () => {
    const file = wav({ channels: 2, samples: [[100, 200, 300], [-100, -200, -300]] });
    const split = splitStereoWav(file);
    expect(split).not.toBeNull();
    expect(samplesOf(split!.left)).toEqual([100, 200, 300]);
    expect(samplesOf(split!.right)).toEqual([-100, -200, -300]);
  });

  // Each half must be a playable mono WAV in its own right -- Workers AI is handed these bytes
  // directly, and a body with the source's stereo header would be read at double speed.
  it("writes a mono header carrying the source's rate and depth", () => {
    const file = wav({ channels: 2, sampleRate: 16000, samples: [[1, 2], [3, 4]] });
    const { left } = splitStereoWav(file)!;
    const view = new DataView(left.buffer);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(4, true)).toBe(left.length - 8); // RIFF size
    expect(view.getUint32(40, true)).toBe(left.length - 44); // data size
  });

  // Twilio is not the only writer of WAV files. A LIST or fact chunk ahead of `data` would put a
  // fixed-44-byte reader one chunk out, and the split would be silence and noise rather than speech.
  it("finds the data chunk after another chunk", () => {
    const file = wav({ channels: 2, extraChunk: true, samples: [[7, 8], [9, 10]] });
    expect(samplesOf(splitStereoWav(file)!.left)).toEqual([7, 8]);
  });

  // Everything below returns null, which means "keep the unlabelled transcript". Guessing would
  // attribute invented words to a named speaker, which is worse than not labelling at all.
  it("refuses a mono file", () => {
    expect(splitStereoWav(wav({ channels: 1, samples: [[1, 2, 3]] }))).toBeNull();
  });

  it("refuses compressed audio it cannot decode", () => {
    expect(splitStereoWav(wav({ channels: 2, format: 17, samples: [[1], [2]] }))).toBeNull();
  });

  it("refuses anything that is not a RIFF/WAVE file", () => {
    expect(splitStereoWav(new Uint8Array(64))).toBeNull();
    expect(splitStereoWav(new Uint8Array(8))).toBeNull(); // shorter than a header
  });

  it("refuses a file past the size cap rather than risking the worker's memory", () => {
    const huge = new Uint8Array(MAX_SPLIT_BYTES + 1);
    huge.set(wav({ channels: 2, samples: [[1], [2]] }).subarray(0, 44));
    expect(splitStereoWav(huge)).toBeNull();
  });

  // A `data` size larger than the bytes actually present: take what is there instead of reading off
  // the end of the buffer.
  it("survives a truncated file", () => {
    const file = wav({ channels: 2, samples: [[5, 6], [7, 8]], dataSizeOverride: 9999 });
    const split = splitStereoWav(file);
    expect(split).not.toBeNull();
    expect(samplesOf(split!.left)).toEqual([5, 6]);
  });
});

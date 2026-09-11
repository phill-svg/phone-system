import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getBusinessHours,
  setBusinessHours,
  getCallBlocklist,
  setCallBlocklist,
  getRecordingEnabled,
  setRecordingEnabled,
  getTranscriptStaffChannel,
  setTranscriptStaffChannel,
} from "../../src/db/settings";

// The value that decides whether every speaker-labelled transcript reads backwards, attributing the
// customer's words to staff and presenting it as fact. It had no test at all until the recording
// moved to the <Dial> on 2026-09-12 and the correct default inverted.
describe("settings.transcriptStaffChannel", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  // 1, because `record-from-answer-dual` sits on the STAFF leg's <Dial> and a Dial recording puts
  // channel 1 on the parent call. Not 2 -- that was right only while this was a <Conference>
  // recording, where channel 1 goes to whoever joined first (the caller, who is redirected in
  // before the staff leg answers).
  it("defaults staff to channel 1, matching the Dial dual recording", async () => {
    expect(await getTranscriptStaffChannel(env.DB)).toBe(1);
  });

  it("round-trips an explicit override in both directions", async () => {
    await setTranscriptStaffChannel(env.DB, 2);
    expect(await getTranscriptStaffChannel(env.DB)).toBe(2);
    await setTranscriptStaffChannel(env.DB, 1);
    expect(await getTranscriptStaffChannel(env.DB)).toBe(1);
  });

  // A corrupt or hand-edited row must not throw on the transcript path, and must not silently become
  // the OTHER channel either -- falling back to the default is the only safe reading.
  it("falls back to the default rather than throwing on a junk stored value", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('transcript_staff_channel', '7')").run();
    expect(await getTranscriptStaffChannel(env.DB)).toBe(1);
  });
});

describe("settings.businessHours", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("returns a sensible default when nothing is stored", async () => {
    const schedule = await getBusinessHours(env.DB);
    expect(schedule.mon).toEqual({ open: "07:00", close: "17:00" });
    expect(schedule.sat).toEqual({ open: "08:00", close: "12:00" });
    expect(schedule.sun).toBeNull();
  });

  it("round-trips a custom schedule", async () => {
    const custom = {
      mon: { open: "08:00", close: "16:00" },
      tue: { open: "08:00", close: "16:00" },
      wed: { open: "08:00", close: "16:00" },
      thu: { open: "08:00", close: "16:00" },
      fri: { open: "08:00", close: "16:00" },
      sat: null,
      sun: null,
    };
    await setBusinessHours(env.DB, custom);
    expect(await getBusinessHours(env.DB)).toEqual(custom);
  });
});

describe("call blocklist", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("returns an empty array when nothing is set", async () => {
    expect(await getCallBlocklist(env.DB)).toEqual([]);
  });

  it("round-trips a saved list", async () => {
    await setCallBlocklist(env.DB, ["+61400000000", "+61400000001"]);
    expect(await getCallBlocklist(env.DB)).toEqual(["+61400000000", "+61400000001"]);
  });
});

describe("recording setting", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'recording_enabled'").run();
  });
  it("defaults to true when unset", async () => {
    expect(await getRecordingEnabled(env.DB)).toBe(true);
  });
  it("round-trips false and true", async () => {
    await setRecordingEnabled(env.DB, false);
    expect(await getRecordingEnabled(env.DB)).toBe(false);
    await setRecordingEnabled(env.DB, true);
    expect(await getRecordingEnabled(env.DB)).toBe(true);
  });
});

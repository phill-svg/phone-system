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

  // 2, because an inbound call is recorded on the CALLER's own <Dial> and a Dial recording puts
  // channel 1 on the parent call -- the customer. It was briefly 1 on 2026-09-12, when the recording
  // sat on the staff leg's <Dial>; that placement recorded a transferred call twice and labelled
  // every outbound transcript backwards, so both it and this default went back.
  it("defaults staff to channel 2, matching the caller-leg Dual recording", async () => {
    expect(await getTranscriptStaffChannel(env.DB)).toBe(2);
  });

  it("round-trips an explicit override in both directions", async () => {
    await setTranscriptStaffChannel(env.DB, 1);
    expect(await getTranscriptStaffChannel(env.DB)).toBe(1);
    await setTranscriptStaffChannel(env.DB, 2);
    expect(await getTranscriptStaffChannel(env.DB)).toBe(2);
  });

  // Genuinely UNPARSEABLE, not just out of range. The first version of this test seeded '7', which
  // is valid JSON -- JSON.parse never threw, so the try/catch it claimed to cover was never
  // executed and deleting the guard left the test green. That matters here specifically: this is
  // awaited inline on the recording-status webhook, AFTER recording_url has been written, so a
  // throw 500s a callback whose work is half done and Twilio retries it.
  it.each([["not json", "two"], ["empty string", ""], ["out of range but valid json", "7"]])(
    "falls back to the default rather than throwing on a junk stored value (%s)",
    async (_label, stored) => {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'transcript_staff_channel'").run();
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('transcript_staff_channel', ?)").bind(stored).run();
      await expect(getTranscriptStaffChannel(env.DB)).resolves.toBe(2);
    }
  );
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

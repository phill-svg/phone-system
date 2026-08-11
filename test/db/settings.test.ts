import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getBusinessHours,
  setBusinessHours,
  getStaffRingList,
  setStaffRingList,
  getCallBlocklist,
  setCallBlocklist,
} from "../../src/db/settings";

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

describe("settings.staffRingList", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await getStaffRingList(env.DB)).toEqual([]);
  });

  it("round-trips a ring list", async () => {
    const list = [
      { label: "Phill (mobile)", number: "+61400000000" },
      { label: "On-call", number: "+61400000001" },
    ];
    await setStaffRingList(env.DB, list);
    expect(await getStaffRingList(env.DB)).toEqual(list);
  });

  it("round-trips a ring list with mixed isOnCall values unchanged", async () => {
    const list = [
      { label: "Phill (mobile)", number: "+61400000000", isOnCall: true },
      { label: "Backup", number: "+61400000001", isOnCall: false },
      { label: "No isOnCall field", number: "+61400000002" },
    ];
    await setStaffRingList(env.DB, list);
    expect(await getStaffRingList(env.DB)).toEqual(list);
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

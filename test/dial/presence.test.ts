import { describe, it, expect } from "vitest";
import { isOnShift, isStaffAvailable, hasFreshHeartbeat, HEARTBEAT_STALE_MS, type StaffPresenceRow } from "../../src/dial/presence";

const MON_10AM = new Date("2026-08-10T00:00:00.000Z"); // Mon 10:00 Australia/Sydney (UTC+10 in Aug)
const SCHEDULE_9_TO_5 = {
  mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" }, thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" }, sat: null, sun: null,
};

function staff(overrides: Partial<StaffPresenceRow>): StaffPresenceRow {
  return {
    email: "a@b.com", role: "staff", status: "available", awayReason: null,
    schedule: SCHEDULE_9_TO_5, lastHeartbeatAt: MON_10AM.getTime(), ringPriority: 100, ...overrides,
  };
}

describe("isStaffAvailable", () => {
  it("is available when status is available and within schedule", () => {
    expect(isStaffAvailable(staff({}), MON_10AM)).toBe(true);
  });

  it("is unavailable when status is away", () => {
    expect(isStaffAvailable(staff({ status: "away", awayReason: "lunch" }), MON_10AM)).toBe(false);
  });

  it("is unavailable when status is offline", () => {
    expect(isStaffAvailable(staff({ status: "offline" }), MON_10AM)).toBe(false);
  });

  it("is unavailable outside scheduled hours even if status is available", () => {
    const mon7am = new Date(MON_10AM.getTime() - 3 * 60 * 60 * 1000);
    expect(isStaffAvailable(staff({}), mon7am)).toBe(false);
  });

  // The heartbeat only ticks while the app is in the FOREGROUND. Requiring a fresh one meant a
  // staff member on shift with the phone in their pocket was silently absent from the roster.
  // Incoming calls wake a closed app by VoIP push, so a stale heartbeat no longer means unreachable.
  it("is available on shift even when the heartbeat is stale -- VoIP push wakes a closed app", () => {
    const stale = staff({ lastHeartbeatAt: MON_10AM.getTime() - HEARTBEAT_STALE_MS - 1 });
    expect(isStaffAvailable(stale, MON_10AM)).toBe(true);
  });

  it("is available on shift even when there has never been a heartbeat", () => {
    expect(isStaffAvailable(staff({ lastHeartbeatAt: null }), MON_10AM)).toBe(true);
  });

  // Presence is still respected -- this change only removed the heartbeat, not the person's own
  // choice or their schedule.
  it("still excludes away and offline regardless of heartbeat", () => {
    expect(isStaffAvailable(staff({ status: "away", lastHeartbeatAt: MON_10AM.getTime() }), MON_10AM)).toBe(false);
    expect(isStaffAvailable(staff({ status: "offline", lastHeartbeatAt: MON_10AM.getTime() }), MON_10AM)).toBe(false);
  });
});

describe("hasFreshHeartbeat", () => {
  // Kept for display/diagnostics -- it no longer gates ringing.
  it("reports whether the app has checked in recently", () => {
    expect(hasFreshHeartbeat(staff({}), MON_10AM)).toBe(true);
    expect(hasFreshHeartbeat(staff({ lastHeartbeatAt: MON_10AM.getTime() - HEARTBEAT_STALE_MS - 1 }), MON_10AM)).toBe(false);
    expect(hasFreshHeartbeat(staff({ lastHeartbeatAt: null }), MON_10AM)).toBe(false);
  });
});

const OPEN_ALL_DAY = {
  mon: { open: "00:00", close: "23:59" }, tue: { open: "00:00", close: "23:59" },
  wed: { open: "00:00", close: "23:59" }, thu: { open: "00:00", close: "23:59" },
  fri: { open: "00:00", close: "23:59" }, sat: { open: "00:00", close: "23:59" },
  sun: { open: "00:00", close: "23:59" },
};
const base = (over: Partial<StaffPresenceRow> = {}): StaffPresenceRow => ({
  email: "a@b.com", role: "staff", status: "available", awayReason: null,
  schedule: OPEN_ALL_DAY, lastHeartbeatAt: Date.now(), ringPriority: 100, ...over,
});

describe("isOnShift", () => {
  const now = new Date();
  it("true when available + within hours, regardless of heartbeat", () => {
    expect(isOnShift(base({ lastHeartbeatAt: null }), now)).toBe(true);
    expect(isOnShift(base({ lastHeartbeatAt: now.getTime() - HEARTBEAT_STALE_MS - 1 }), now)).toBe(true);
  });
  it("false when not available", () => {
    expect(isOnShift(base({ status: "away" }), now)).toBe(false);
  });
});

describe("isStaffAvailable no longer requires a heartbeat", () => {
  const now = new Date();
  it("true when on-shift with a stale heartbeat", () => {
    expect(isStaffAvailable(base({ lastHeartbeatAt: now.getTime() - HEARTBEAT_STALE_MS - 1 }), now)).toBe(true);
  });
  it("true when on-shift with a fresh heartbeat", () => {
    expect(isStaffAvailable(base(), now)).toBe(true);
  });
});

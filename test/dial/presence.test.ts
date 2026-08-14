import { describe, it, expect } from "vitest";
import { isStaffAvailable, HEARTBEAT_STALE_MS, type StaffPresenceRow } from "../../src/dial/presence";

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
  it("is available when status is available, within schedule, and heartbeat is fresh", () => {
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

  it("is unavailable when the heartbeat is stale", () => {
    const stale = staff({ lastHeartbeatAt: MON_10AM.getTime() - HEARTBEAT_STALE_MS - 1 });
    expect(isStaffAvailable(stale, MON_10AM)).toBe(false);
  });

  it("is unavailable when there has never been a heartbeat", () => {
    expect(isStaffAvailable(staff({ lastHeartbeatAt: null }), MON_10AM)).toBe(false);
  });
});

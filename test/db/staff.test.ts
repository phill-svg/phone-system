import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getStaffRoster, getStaffByEmail, setStaffStatus, setStaffSchedule, touchHeartbeat } from "../../src/db/staff";

describe("staff presence data layer", () => {
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM staff_users`);
    await env.DB.prepare(
      "INSERT INTO staff_users (email, role, created_at, status, schedule) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("a@b.com", "staff", Date.now(), "offline", JSON.stringify({
        mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
      }))
      .run();
  });

  it("getStaffRoster returns parsed rows", async () => {
    const roster = await getStaffRoster(env.DB);
    expect(roster).toHaveLength(1);
    expect(roster[0].email).toBe("a@b.com");
    expect(roster[0].schedule.mon).toEqual({ open: "09:00", close: "17:00" });
  });

  it("getStaffByEmail returns null for an unknown email", async () => {
    expect(await getStaffByEmail(env.DB, "nobody@b.com")).toBeNull();
  });

  it("setStaffStatus updates status and awayReason", async () => {
    await setStaffStatus(env.DB, "a@b.com", "away", "out to lunch");
    const row = await getStaffByEmail(env.DB, "a@b.com");
    expect(row?.status).toBe("away");
    expect(row?.awayReason).toBe("out to lunch");
  });

  it("setStaffSchedule overwrites the schedule JSON", async () => {
    const newSchedule = {
      mon: { open: "08:00", close: "16:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
    };
    await setStaffSchedule(env.DB, "a@b.com", newSchedule);
    const row = await getStaffByEmail(env.DB, "a@b.com");
    expect(row?.schedule).toEqual(newSchedule);
  });

  it("touchHeartbeat sets lastHeartbeatAt to roughly now", async () => {
    const before = Date.now();
    await touchHeartbeat(env.DB, "a@b.com");
    const row = await getStaffByEmail(env.DB, "a@b.com");
    expect(row?.lastHeartbeatAt).toBeGreaterThanOrEqual(before);
  });
});

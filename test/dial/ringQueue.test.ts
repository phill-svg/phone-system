import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveRingTargets, toDiallableNumber } from "../../src/dial/ringQueue";

const NOW = new Date("2026-08-10T00:00:00.000Z"); // Mon 10:00 Australia/Sydney
const OPEN_SCHEDULE = JSON.stringify({
  mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
});

async function insertStaff(
  email: string,
  status: string,
  heartbeatAt: number | null,
  mobile: string | null = null,
  priority = 100
) {
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, mobile_number, ring_priority) VALUES (?, 'staff', ?, ?, ?, ?, ?, ?)"
  )
    .bind(email, Date.now(), status, OPEN_SCHEDULE, heartbeatAt, mobile, priority)
    .run();
}

describe("resolveRingTargets", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
  });

  it("'all' resolves to every currently-available staff member, as client identities", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime());
    await insertStaff("c@b.com", "offline", NOW.getTime());
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual(["client:a@b.com"]);
  });

  it("a specific staff list only considers those staff, filtered by availability", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime());
    await insertStaff("b@b.com", "available", NOW.getTime());
    expect(await resolveRingTargets(env.DB, ["a@b.com"], NOW)).toEqual(["client:a@b.com"]);
  });

  it("returns an empty array when nobody targeted is available", async () => {
    await insertStaff("a@b.com", "away", NOW.getTime());
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual([]);
  });

  it("appends an available staff member's mobile as a failover leg after their softphone", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime(), "0412 345 678");
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual(["client:a@b.com", "+61412345678"]);
  });

  it("omits the mobile leg when a staff member has no mobile set", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime(), null);
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual(["client:a@b.com"]);
  });

  it("interleaves softphone+mobile per staff member so cascade rings desk then mobile", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime(), "0412 345 678");
    await insertStaff("b@b.com", "available", NOW.getTime(), "+61423000000");
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual([
      "client:a@b.com", "+61412345678", "client:b@b.com", "+61423000000",
    ]);
  });

  it("rings staff in ascending priority order (lower rings first), regardless of insert order", async () => {
    await insertStaff("general@b.com", "available", NOW.getTime(), null, 100);
    await insertStaff("senior@b.com", "available", NOW.getTime(), null, 10);
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual(["client:senior@b.com", "client:general@b.com"]);
  });
});

describe("toDiallableNumber", () => {
  it("normalizes AU mobile formats to E.164", () => {
    expect(toDiallableNumber("0412 345 678")).toBe("+61412345678");
    expect(toDiallableNumber("+61 412 345 678")).toBe("+61412345678");
    expect(toDiallableNumber("61412345678")).toBe("+61412345678");
    expect(toDiallableNumber("(02) 8395 3312")).toBe("+61283953312");
  });
  it("returns null for too-short junk", () => {
    expect(toDiallableNumber("123")).toBeNull();
    expect(toDiallableNumber("")).toBeNull();
  });
});

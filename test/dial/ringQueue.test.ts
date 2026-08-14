import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveRingTargets } from "../../src/dial/ringQueue";

const NOW = new Date("2026-08-10T00:00:00.000Z"); // Mon 10:00 Australia/Sydney
const OPEN_SCHEDULE = JSON.stringify({
  mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
});

async function insertStaff(email: string, status: string, heartbeatAt: number | null, priority = 100) {
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, ring_priority) VALUES (?, 'staff', ?, ?, ?, ?, ?)"
  )
    .bind(email, Date.now(), status, OPEN_SCHEDULE, heartbeatAt, priority)
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

  it("rings staff in ascending priority order (lower rings first), regardless of insert order", async () => {
    await insertStaff("general@b.com", "available", NOW.getTime(), 100);
    await insertStaff("senior@b.com", "available", NOW.getTime(), 10);
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual(["client:senior@b.com", "client:general@b.com"]);
  });
});

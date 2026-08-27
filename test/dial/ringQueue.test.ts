import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveRingTargets } from "../../src/dial/ringQueue";
import { setUserSettings } from "../../src/db/userSettings";

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

const OPEN = JSON.stringify({
  mon: { open: "00:00", close: "23:59" }, tue: { open: "00:00", close: "23:59" },
  wed: { open: "00:00", close: "23:59" }, thu: { open: "00:00", close: "23:59" },
  fri: { open: "00:00", close: "23:59" }, sat: { open: "00:00", close: "23:59" },
  sun: { open: "00:00", close: "23:59" },
});

async function seedStaff(email: string, opts: { online?: boolean; priority?: number } = {}) {
  const online = opts.online ?? true;
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, ring_priority) VALUES (?, 'staff', 1, 'available', ?, ?, ?)"
  ).bind(email, OPEN, online ? Date.now() : null, opts.priority ?? 100).run();
}

describe("resolveRingTargets ring-my-mobile", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
    await env.DB.prepare("DELETE FROM staff_users").run();
  });

  it("adds a pstn leg for an on-shift staff member who enabled ring_my_mobile", async () => {
    await seedStaff("phill@b.com");
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets).toContain("client:phill@b.com");
    expect(targets).toContain("pstn:phill@b.com|+61412345678");
  });

  it("rings the mobile even when the softphone is OFFLINE (stale heartbeat), if on-shift", async () => {
    await seedStaff("phill@b.com", { online: false });
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets).not.toContain("client:phill@b.com"); // softphone offline → no client leg
    expect(targets).toContain("pstn:phill@b.com|+61412345678"); // but the mobile still rings
  });

  it("no mobile leg when ring_my_mobile is off or the number is invalid", async () => {
    await seedStaff("a@b.com");
    await seedStaff("c@b.com");
    await setUserSettings(env.DB, "a@b.com", { ring_my_mobile: false, mobile_number: "0412345678" });
    await setUserSettings(env.DB, "c@b.com", { ring_my_mobile: true, mobile_number: "nope" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets.filter((t) => t.startsWith("pstn:"))).toEqual([]);
  });
});

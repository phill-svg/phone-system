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

  // Signing in flips a staff row to `available`, and the simultaneous strategy rings everyone
  // available at once -- ring_priority protects nobody there. Without this exclusion an App Review
  // demo login becomes a live destination and can answer a real customer's call.
  it("never rings an excluded (demo) account, even when it is available and asked for by name", async () => {
    await insertStaff("real@b.com", "available", NOW.getTime());
    await insertStaff("reviewer@b.com", "available", NOW.getTime());

    expect(await resolveRingTargets(env.DB, "all", NOW, ["reviewer@b.com"])).toEqual(["client:real@b.com"]);
    // Also when a ring node names them explicitly, and regardless of address casing.
    expect(await resolveRingTargets(env.DB, ["reviewer@b.com"], NOW, ["REVIEWER@b.com"])).toEqual([]);
  });

  it("excludes a demo account from ring-my-mobile too, not just the softphone leg", async () => {
    await insertStaff("reviewer@b.com", "available", NOW.getTime());
    await setUserSettings(env.DB, "reviewer@b.com", { ring_my_mobile: true, mobile_number: "0491570006" } as any);
    expect(await resolveRingTargets(env.DB, "all", NOW, ["reviewer@b.com"])).toEqual([]);
  });

  it("rings everyone when no exclusions are configured", async () => {
    await insertStaff("real@b.com", "available", NOW.getTime());
    expect(await resolveRingTargets(env.DB, "all", NOW, [])).toEqual(["client:real@b.com"]);
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

describe("resolveRingTargets ring-my-mobile (divert)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
    await env.DB.prepare("DELETE FROM staff_users").run();
  });

  it("diverts to the mobile INSTEAD of the softphone - the app must not ring", async () => {
    await seedStaff("phill@b.com");
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets).toEqual(["pstn:phill@b.com|+61412345678"]);
  });

  it("rings the mobile even when the softphone is OFFLINE (stale heartbeat), if on-shift", async () => {
    await seedStaff("phill@b.com", { online: false });
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    expect(await resolveRingTargets(env.DB, "all", new Date())).toEqual(["pstn:phill@b.com|+61412345678"]);
  });

  it("rings the softphone when ring_my_mobile is off", async () => {
    await seedStaff("a@b.com");
    await setUserSettings(env.DB, "a@b.com", { ring_my_mobile: false, mobile_number: "0412345678" });
    expect(await resolveRingTargets(env.DB, "all", new Date())).toEqual(["client:a@b.com"]);
  });

  // An unusable number must never silently drop the person from the ring list -- falling back to
  // the softphone keeps them reachable instead of sending the caller straight to voicemail.
  it("falls back to the softphone when ring_my_mobile is on but the number is invalid", async () => {
    await seedStaff("c@b.com");
    await setUserSettings(env.DB, "c@b.com", { ring_my_mobile: true, mobile_number: "nope" });
    expect(await resolveRingTargets(env.DB, "all", new Date())).toEqual(["client:c@b.com"]);
  });

  it("drops a staff member entirely when their number is invalid AND their softphone is offline", async () => {
    await seedStaff("c@b.com", { online: false });
    await setUserSettings(env.DB, "c@b.com", { ring_my_mobile: true, mobile_number: "nope" });
    expect(await resolveRingTargets(env.DB, "all", new Date())).toEqual([]);
  });

  // The old implementation returned [...clientLegs, ...pstnLegs], which reordered people by leg
  // type and broke cascade's priority contract. One leg per person keeps ring_priority intact.
  it("keeps ring_priority order across mixed mobile and softphone legs", async () => {
    await seedStaff("senior@b.com", { priority: 10 });
    await seedStaff("general@b.com", { priority: 100 });
    await setUserSettings(env.DB, "senior@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    expect(await resolveRingTargets(env.DB, "all", new Date())).toEqual([
      "pstn:senior@b.com|+61412345678",
      "client:general@b.com",
    ]);
  });
});

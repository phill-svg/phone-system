import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { setStaffStatus, resetAvailabilityForNewDay } from "../../src/db/staff";
import { localDateKey } from "../../src/ivr/businessHours";
import { handleMe } from "../../src/api/me";

const TODAY = localDateKey(new Date());
const YESTERDAY = localDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

async function seed(email: string, status: string, setOn: string | null) {
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, status_set_on) VALUES (?, 'staff', 1, ?, ?)"
  )
    .bind(email, status, setOn)
    .run();
}
async function read(email: string) {
  return await env.DB.prepare("SELECT status, away_reason, status_set_on FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ status: string; away_reason: string | null; status_set_on: string | null }>();
}

describe("localDateKey", () => {
  it("is the Canberra calendar date, not the Worker's UTC one", () => {
    // 2026-09-03 23:30 UTC is already the 4th in Canberra (UTC+10). Asking in UTC would expire an
    // override a day late, or leave someone unavailable into the next working morning.
    expect(localDateKey(new Date("2026-09-03T23:30:00Z"))).toBe("2026-09-04");
    expect(localDateKey(new Date("2026-09-03T13:00:00Z"))).toBe("2026-09-03");
  });
});

describe("setStaffStatus", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users").run();
  });

  it("stamps the day an unavailable choice was made", async () => {
    await seed("a@b.com", "available", null);
    await setStaffStatus(env.DB, "a@b.com", "away", "off sick", TODAY);
    expect(await read("a@b.com")).toMatchObject({ status: "away", away_reason: "off sick", status_set_on: TODAY });
  });

  // Going back to available has nothing to expire, so the stamp is cleared rather than left to
  // confuse the next reset.
  it("clears the stamp when someone marks themselves available again", async () => {
    await seed("a@b.com", "away", YESTERDAY);
    await setStaffStatus(env.DB, "a@b.com", "available", null, TODAY);
    expect(await read("a@b.com")).toMatchObject({ status: "available", status_set_on: null });
  });
});

describe("resetAvailabilityForNewDay", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users").run();
  });

  // The whole point: one sick day must not remove someone from the ring roster all week.
  it("puts yesterday's unavailable staff back to available", async () => {
    await seed("sick@b.com", "away", YESTERDAY);
    expect(await resetAvailabilityForNewDay(env.DB, TODAY)).toBe(1);
    expect(await read("sick@b.com")).toMatchObject({ status: "available", away_reason: null, status_set_on: null });
  });

  it("leaves today's choice alone -- the override lasts the rest of the day", async () => {
    await seed("today@b.com", "away", TODAY);
    expect(await resetAvailabilityForNewDay(env.DB, TODAY)).toBe(0);
    expect(await read("today@b.com")).toMatchObject({ status: "away", status_set_on: TODAY });
  });

  // A row that was never set by the person carries no intent -- e.g. the app used to write
  // "offline" whenever it closed. Those must not keep anyone off the roster.
  it("resets an unavailable staff member who never chose it", async () => {
    await seed("stale@b.com", "offline", null);
    expect(await resetAvailabilityForNewDay(env.DB, TODAY)).toBe(1);
    expect(await read("stale@b.com")).toMatchObject({ status: "available" });
  });

  it("does not touch staff who are already available", async () => {
    await seed("ok@b.com", "available", null);
    expect(await resetAvailabilityForNewDay(env.DB, TODAY)).toBe(0);
  });

  it("resets several people in one pass and reports how many", async () => {
    await seed("a@b.com", "away", YESTERDAY);
    await seed("b@b.com", "offline", null);
    await seed("c@b.com", "away", TODAY);
    await seed("d@b.com", "available", null);
    expect(await resetAvailabilityForNewDay(env.DB, TODAY)).toBe(2);
  });
});

describe("GET /api/me", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users").run();
  });

  it("reports the caller's own availability so the app can show and change it", async () => {
    await seed("a@b.com", "away", TODAY);
    await env.DB.prepare("UPDATE staff_users SET away_reason = 'off sick' WHERE email = ?").bind("a@b.com").run();
    const body = (await (await handleMe(env.DB, { email: "a@b.com", role: "staff" })).json()) as Record<string, unknown>;
    expect(body).toEqual({ email: "a@b.com", role: "staff", status: "away", awayReason: "off sick" });
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleGetStaffRoster, handlePutStaffSchedule } from "../../src/api/staff";

const SCHEDULE = { mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

describe("handleGetStaffRoster", () => {
  it("lists every staff member's email/role/status", async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const res = await handleGetStaffRoster(env.DB);
    const roster = await res.json<{ email: string }[]>();
    expect(roster.map((r) => r.email)).toEqual(["a@b.com"]);
  });
});

describe("handlePutStaffSchedule", () => {
  it("rejects non-admins", async () => {
    const res = await handlePutStaffSchedule(
      new Request("http://x", { method: "PUT", body: JSON.stringify(SCHEDULE) }),
      env.DB,
      "a@b.com",
      { email: "staff@b.com", role: "staff" }
    );
    expect(res.status).toBe(403);
  });

  it("saves a valid schedule for an admin", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const res = await handlePutStaffSchedule(
      new Request("http://x", { method: "PUT", body: JSON.stringify(SCHEDULE) }),
      env.DB,
      "a@b.com",
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT schedule FROM staff_users WHERE email = 'a@b.com'").first<{ schedule: string }>();
    expect(JSON.parse(row!.schedule)).toEqual(SCHEDULE);
  });
});

import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetStaffAdminList } from "../../src/api/staff";

// The pool authenticates every SELF.fetch as phill via AUTH_MODE=dev; the role still comes from
// the D1 row, so flipping that row is how a non-admin request is simulated.
const DEV = "phill@tcbpestcontrolcanberra.com.au";
const MATE = "mate@example.com";
const SCHEDULE = { mon: { open: "08:00", close: "16:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

type AdminStaff = {
  email: string;
  role: string;
  status: string;
  schedule: typeof SCHEDULE;
  ringPriority: number;
  hasPassword: boolean;
};

describe("GET /api/admin/staff", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(MATE).run();
    await env.DB.prepare("UPDATE staff_users SET role = 'admin' WHERE email = ?").bind(DEV).run();
  });

  it("returns schedule, ring order and password state for every staff member", async () => {
    await env.DB
      .prepare("INSERT INTO staff_users (email, role, created_at, schedule, ring_priority, password_hash) VALUES (?, 'staff', 1, ?, 20, NULL)")
      .bind(MATE, JSON.stringify(SCHEDULE))
      .run();

    const res = await SELF.fetch("https://example.com/api/admin/staff");
    expect(res.status).toBe(200);
    const rows = await res.json<AdminStaff[]>();

    const mate = rows.find((r) => r.email === MATE);
    expect(mate).toBeDefined();
    expect(mate!.schedule).toEqual(SCHEDULE);
    expect(mate!.ringPriority).toBe(20);
    // Invited but never set a password -- the Staff Access screen shows this as "Invited".
    expect(mate!.hasPassword).toBe(false);
    expect(rows.map((r) => r.email)).toEqual([...rows.map((r) => r.email)].sort());
  });

  it("is forbidden for a non-admin, even though it is only a read", async () => {
    await env.DB.prepare("UPDATE staff_users SET role = 'staff' WHERE email = ?").bind(DEV).run();
    const res = await SELF.fetch("https://example.com/api/admin/staff");
    expect(res.status).toBe(403);
  });

  it("defaults ring priority to 100 when the column is NULL", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(MATE).run();
    const res = await handleGetStaffAdminList(env.DB);
    const rows = await res.json<AdminStaff[]>();
    expect(rows.find((r) => r.email === MATE)!.ringPriority).toBe(100);
  });
});

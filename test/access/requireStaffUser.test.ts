import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { requireStaffUser } from "../../src/access/requireStaffUser";
import { createSession } from "../../src/access/session";
import { sessionCookieHeader } from "../../src/access/session";

const ADMIN = "phill@tcbpestcontrolcanberra.com.au";

describe("requireStaffUser (session-based)", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("DELETE FROM staff_users WHERE email != ?").bind(ADMIN).run();
    await testEnv.DB.prepare("DELETE FROM sessions").run();
  });

  it("dev mode returns the configured dev staff user", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev", DEV_STAFF_EMAIL: ADMIN };
    const req = new Request("https://x/api/me");
    expect(await requireStaffUser(req, env as any, { isApi: true })).toEqual({ email: ADMIN, role: "admin" });
  });

  it("dev mode 500s if DEV_STAFF_EMAIL is unset", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev" };
    const res = (await requireStaffUser(new Request("https://x/api/me"), env as any, { isApi: true })) as Response;
    expect(res.status).toBe(500);
  });

  it("no session: API request → 401", async () => {
    const env = { DB: testEnv.DB };
    const res = (await requireStaffUser(new Request("https://x/api/me"), env as any, { isApi: true })) as Response;
    expect(res.status).toBe(401);
  });

  it("no session: page request → 302 to /login", async () => {
    const env = { DB: testEnv.DB };
    const res = (await requireStaffUser(new Request("https://x/admin/live"), env as any, { isApi: false })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("valid session cookie → resolves staff user with role", async () => {
    const token = await createSession(testEnv.DB, ADMIN);
    const env = { DB: testEnv.DB };
    const req = new Request("https://x/admin/live", { headers: { Cookie: sessionCookieHeader(token) } });
    expect(await requireStaffUser(req, env as any, { isApi: false })).toEqual({ email: ADMIN, role: "admin" });
  });

  it("authenticated identity not in staff_users → 403", async () => {
    // NOTE: deviates from the task brief's verbatim test, which inserted a
    // staff_users row, created a session for it, then deleted the row to
    // simulate "removed after login." That's structurally impossible here:
    // sessions.email has a NOT NULL FK to staff_users(email) with no cascade
    // (migrations/0016_auth.sql), so D1 rejects the DELETE with
    // "FOREIGN KEY constraint failed" before requireStaffUser is ever
    // exercised (verified empirically, not a guess). Dev mode reaches the
    // same 403 branch without needing a session row at all: an email that
    // resolves (via DEV_STAFF_EMAIL) but has no staff_users row.
    const env = { DB: testEnv.DB, AUTH_MODE: "dev", DEV_STAFF_EMAIL: "ghost@example.com" };
    const req = new Request("https://x/api/me");
    const res = (await requireStaffUser(req, env as any, { isApi: true })) as Response;
    expect(res.status).toBe(403);
  });
});

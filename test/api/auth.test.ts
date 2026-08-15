// test/api/auth.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/access/password";

const EMAIL = "loginer@example.com";

async function seedUser(password: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(EMAIL).run();
  await env.DB.prepare("UPDATE staff_users SET password_hash = ? WHERE email = ?").bind(await hashPassword(password), EMAIL).run();
}

describe("login routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("GET /login returns the branded form", async () => {
    const res = await SELF.fetch("https://example.com/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain('name="password"');
  });

  it("POST /login with correct creds sets a session cookie and redirects", async () => {
    await seedUser("supersecret10");
    const res = await SELF.fetch("https://example.com/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: EMAIL, password: "supersecret10" }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/live");
    expect(res.headers.get("Set-Cookie") ?? "").toContain("tcb_session=");
  });

  it("POST /login with wrong password re-renders with an error and no cookie", async () => {
    await seedUser("supersecret10");
    const res = await SELF.fetch("https://example.com/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: EMAIL, password: "wrongwrong10" }).toString(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("Invalid email or password");
  });

  it("GET /logout clears the cookie and redirects to /login", async () => {
    const res = await SELF.fetch("https://example.com/logout", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Set-Cookie") ?? "").toContain("Max-Age=0");
  });
});

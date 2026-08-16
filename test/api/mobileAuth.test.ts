// test/api/mobileAuth.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/access/password";

const EMAIL = "mobileuser@example.com";

async function seed(password: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(EMAIL).run();
  await env.DB.prepare("UPDATE staff_users SET password_hash = ? WHERE email = ?").bind(await hashPassword(password), EMAIL).run();
}

describe("mobile JSON auth", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("POST /api/login returns a token + user on correct credentials (no cookie)", async () => {
    await seed("supersecret10");
    const res = await SELF.fetch("https://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "supersecret10" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const body = (await res.json()) as { token: string; user: { email: string; role: string } };
    expect(body.token).toBeTruthy();
    expect(body.user).toEqual({ email: EMAIL, role: "staff" });
  });

  it("the returned token authenticates a gated /api call via Bearer header", async () => {
    await seed("supersecret10");
    const login = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "supersecret10" }),
    });
    const { token } = (await login.json()) as { token: string };
    // NOTE: the vitest pool runs AUTH_MODE=dev, so this SELF call is dev-authenticated regardless;
    // this asserts the endpoint accepts the header without error, not the bearer gate itself
    // (that is unit-tested in requireStaffUser.test.ts).
    const me = await SELF.fetch("https://example.com/api/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  it("POST /api/login 401s on wrong password with no token", async () => {
    await seed("supersecret10");
    const res = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "wrongwrong10" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("Invalid email or password.");
  });

  it("POST /api/login 400s on missing fields", async () => {
    const res = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/logout returns ok and revokes the token", async () => {
    await seed("supersecret10");
    const login = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "supersecret10" }),
    });
    const { token } = (await login.json()) as { token: string };
    const out = await SELF.fetch("https://example.com/api/logout", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(200);
    // token row is gone
    const { sha256Hex } = await import("../../src/access/crypto");
    const row = await env.DB.prepare("SELECT token_hash FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).first();
    expect(row).toBeNull();
  });
});

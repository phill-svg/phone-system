import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueToken } from "../../src/access/passwordTokens";
import { hashPassword } from "../../src/access/password";

const EMAIL = "resetme@example.com";

describe("forgot/set password routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM password_tokens").run();
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(EMAIL).run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POST /forgot-password always returns the neutral 'check your email' page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
    env.SENDGRID_API_KEY = "SG.test";
    env.AUTH_FROM_EMAIL = "no-reply@tcbpestcontrolcanberra.com.au";
    for (const email of [EMAIL, "nobody@example.com"]) {
      const res = await SELF.fetch("https://example.com/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }).toString(),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("we've sent");
    }
  });

  it("GET /set-password with a valid token shows the form; invalid shows a message", async () => {
    const token = await issueToken(env.DB, EMAIL, "invite");
    const ok = await SELF.fetch(`https://example.com/set-password?token=${token}`);
    expect(await ok.text()).toContain('name="password"');
    const bad = await SELF.fetch("https://example.com/set-password?token=bogus");
    expect(await bad.text()).toContain("link");
  });

  it("POST /set-password sets the password, consumes token, and signs in", async () => {
    const token = await issueToken(env.DB, EMAIL, "invite");
    const res = await SELF.fetch("https://example.com/set-password", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password: "brandnewpass10", confirm: "brandnewpass10" }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie") ?? "").toContain("tcb_session=");
    const row = await env.DB.prepare("SELECT password_hash FROM staff_users WHERE email = ?").bind(EMAIL).first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$/);
  });

  it("POST /set-password rejects mismatched or short passwords", async () => {
    const token = await issueToken(env.DB, EMAIL, "reset");
    const res = await SELF.fetch("https://example.com/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password: "short", confirm: "short" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("10 characters");
  });
});

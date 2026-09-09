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
    // The handler swallows any email-send error to avoid revealing account existence, so this
    // path returns the neutral page whether or not the send_email binding is available in tests.
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

  // Two clicks of "Send reset" leave two valid tokens. Consuming one used to leave the other live
  // for the rest of its hour, so whoever held the older email could set the password again
  // afterwards and take the account.
  it("POST /set-password invalidates the account's OTHER outstanding tokens", async () => {
    const first = await issueToken(env.DB, EMAIL, "reset");
    const second = await issueToken(env.DB, EMAIL, "reset");
    expect(first).not.toBe(second);

    const ok = await SELF.fetch("https://example.com/set-password", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: second, password: "brandnewpass10", confirm: "brandnewpass10" }).toString(),
    });
    expect(ok.status).toBe(302);

    // The older link must no longer be usable.
    const stale = await SELF.fetch(`https://example.com/set-password?token=${first}`);
    expect(await stale.text()).toContain("expired");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM password_tokens WHERE email = ?").bind(EMAIL).first<{ n: number }>()
    ).toEqual({ n: 0 });
  });

  // Someone locked out by failed attempts who then legitimately resets their password was still
  // told "too many attempts" on the very next login.
  it("POST /set-password clears the login lockout", async () => {
    const token = await issueToken(env.DB, EMAIL, "reset");
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("INSERT INTO login_attempts (email, attempted_at) VALUES (?, ?)").bind(EMAIL, Date.now()).run();
    }
    await SELF.fetch("https://example.com/set-password", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password: "brandnewpass10", confirm: "brandnewpass10" }).toString(),
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email = ?").bind(EMAIL).first<{ n: number }>()
    ).toEqual({ n: 0 });
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

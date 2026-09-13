// test/access/loginAttempts.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { reserveAttempt, clearAttempts } from "../../src/access/loginAttempts";

const EMAIL = "rate@example.com";

describe("login rate limiting", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
  });

  it("allows 8 attempts in the window and refuses the 9th", async () => {
    for (let i = 0; i < 8; i++) expect(await reserveAttempt(env.DB, EMAIL)).toBe(true);
    expect(await reserveAttempt(env.DB, EMAIL)).toBe(false);
  });

  it("clearAttempts resets the counter", async () => {
    for (let i = 0; i < 8; i++) await reserveAttempt(env.DB, EMAIL);
    await clearAttempts(env.DB, EMAIL);
    expect(await reserveAttempt(env.DB, EMAIL)).toBe(true);
  });
});

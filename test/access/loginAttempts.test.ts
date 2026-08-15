// test/access/loginAttempts.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "../../src/access/loginAttempts";

const EMAIL = "rate@example.com";

describe("login rate limiting", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
  });

  it("is not limited under the threshold and limited at/over it", async () => {
    for (let i = 0; i < 7; i++) await recordFailedAttempt(env.DB, EMAIL);
    expect(await isRateLimited(env.DB, EMAIL)).toBe(false);
    await recordFailedAttempt(env.DB, EMAIL); // 8th
    expect(await isRateLimited(env.DB, EMAIL)).toBe(true);
  });

  it("clearAttempts resets the counter", async () => {
    for (let i = 0; i < 8; i++) await recordFailedAttempt(env.DB, EMAIL);
    await clearAttempts(env.DB, EMAIL);
    expect(await isRateLimited(env.DB, EMAIL)).toBe(false);
  });
});

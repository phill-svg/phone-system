import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getPushTokensForType } from "../../src/db/pushTokens";
import { setUserSettings } from "../../src/db/userSettings";

async function addToken(token: string, email: string | null) {
  await env.DB.prepare(
    "INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)"
  ).bind(token, email).run();
}

describe("getPushTokensForType", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await env.DB.prepare("DELETE FROM user_settings").run();
  });

  it("includes tokens whose owner has the type enabled (default) and null-owner tokens", async () => {
    await addToken("t-default", "a@tcb.example");
    await addToken("t-null", null);
    expect((await getPushTokensForType(env.DB, "notif_sms")).sort()).toEqual(["t-default", "t-null"]);
  });

  it("excludes tokens whose owner disabled the type", async () => {
    await addToken("t-on", "on@tcb.example");
    await addToken("t-off", "off@tcb.example");
    // user_settings.email has an FK to staff_users (migration 0022); seed the row the write needs.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)"
    ).bind("off@tcb.example").run();
    await setUserSettings(env.DB, "off@tcb.example", { notif_sms: false });
    expect(await getPushTokensForType(env.DB, "notif_sms")).toEqual(["t-on"]);
  });
});

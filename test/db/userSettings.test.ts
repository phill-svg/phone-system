import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getUserSettings, setUserSettings, DEFAULT_USER_SETTINGS } from "../../src/db/userSettings";

const EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("userSettings db", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
  });

  it("returns defaults for a user with no stored rows", async () => {
    expect(await getUserSettings(env.DB, EMAIL)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("setUserSettings persists a partial and merges over defaults", async () => {
    const merged = await setUserSettings(env.DB, EMAIL, { notif_sms: false, mobile_number: "0400111222" });
    expect(merged.notif_sms).toBe(false);
    expect(merged.mobile_number).toBe("0400111222");
    expect(merged.notif_incoming).toBe(true); // untouched default
    expect(await getUserSettings(env.DB, EMAIL)).toEqual(merged);
  });

  it("ignores unknown keys", async () => {
    await setUserSettings(env.DB, EMAIL, { bogus: true } as never);
    expect(await getUserSettings(env.DB, EMAIL)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("keeps different users' settings separate", async () => {
    await setUserSettings(env.DB, EMAIL, { notif_sms: false });
    expect((await getUserSettings(env.DB, "other@tcb.example")).notif_sms).toBe(true);
  });
});

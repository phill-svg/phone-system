import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetUserSettings, handlePutUserSettings } from "../../src/api/userSettings";
import { DEFAULT_USER_SETTINGS } from "../../src/db/userSettings";

const staff = { email: "phill@tcbpestcontrolcanberra.com.au", role: "staff" as const };

function put(body: unknown): Request {
  return new Request("https://x/api/settings/me", { method: "PUT", body: JSON.stringify(body) });
}

describe("/api/settings/me", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
  });

  it("GET returns defaults for a fresh user", async () => {
    const res = await handleGetUserSettings(env.DB, staff);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("PUT persists a partial and returns the merged object", async () => {
    const res = await handlePutUserSettings(put({ notif_sms: false }), env.DB, staff);
    expect(res.status).toBe(200);
    expect((await res.json() as typeof DEFAULT_USER_SETTINGS).notif_sms).toBe(false);
    const after = await handleGetUserSettings(env.DB, staff);
    expect((await after.json() as typeof DEFAULT_USER_SETTINGS).notif_sms).toBe(false);
  });

  it("PUT rejects a non-object body with 400", async () => {
    const res = await handlePutUserSettings(put("nope"), env.DB, staff);
    expect(res.status).toBe(400);
  });
});

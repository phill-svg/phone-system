import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRegisterPushToken, notifyMissedCall, notifyVoicemail } from "../../src/api/push";
import { upsertPushToken } from "../../src/db/pushTokens";
import { setUserSettings } from "../../src/db/userSettings";

async function addToken(token: string, email: string) {
  await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1) ON CONFLICT(email) DO NOTHING").bind(email).run();
  await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)").bind(token, email).run();
}

describe("call notifications", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await env.DB.prepare("DELETE FROM user_settings").run();
    await env.DB.prepare("DELETE FROM staff_users WHERE email LIKE '%@n.test'").run();
  });

  it("notifyMissedCall pushes only to notif_missed recipients", async () => {
    await addToken("ExponentPushToken[t-on]", "on@n.test");
    await addToken("ExponentPushToken[t-off]", "off@n.test");
    await setUserSettings(env.DB, "off@n.test", { notif_missed: false });
    const fetchMock = vi.fn(async (_input: unknown, _init: unknown) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyMissedCall(env.DB, "+61400000000");
    vi.unstubAllGlobals();
    // Expo push posts the recipient token list in the body; assert t-off is excluded.
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain("t-on");
    expect(body).not.toContain("t-off");
  });

  it("notifyVoicemail pushes only to notif_voicemail recipients", async () => {
    await addToken("ExponentPushToken[v-on]", "on2@n.test");
    await addToken("ExponentPushToken[v-off]", "off2@n.test");
    await setUserSettings(env.DB, "off2@n.test", { notif_voicemail: false });
    const fetchMock = vi.fn(async (_input: unknown, _init: unknown) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyVoicemail(env.DB, "+61400000000");
    vi.unstubAllGlobals();
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain("v-on");
    expect(body).not.toContain("v-off");
  });

  it("notifyMissedCall does nothing (no fetch) when there are no recipients", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await notifyMissedCall(env.DB, "+61400000000");
    vi.unstubAllGlobals();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Which build a handset is running is recorded on push registration, because that is the one call
// every signed-in handset makes on launch. These assert the RAW stored value rather than reading it
// back through the health check that normalises it -- a test that reads through the fix is not a
// test, and this write path is the whole reason `blankToNull` and the COALESCE are there.
describe("recording which build a handset is running", () => {
  const T = "ExponentPushToken[build-report]";
  const EMAIL = "builds@n.test";

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens WHERE token = ?").bind(T).run();
  });

  const stored = () =>
    env.DB
      .prepare("SELECT ota_build, native_build, last_seen FROM push_tokens WHERE token = ?")
      .bind(T)
      .first<{ ota_build: string | null; native_build: string | null; last_seen: number }>();

  it("stores both builds a handset reports", async () => {
    await upsertPushToken(env.DB, { token: T, platform: "ios", staffEmail: EMAIL, now: 1, otaBuild: "67", nativeBuild: "5" });
    expect(await stored()).toMatchObject({ ota_build: "67", native_build: "5" });
  });

  // An older handset re-registering sends neither field. Overwriting with NULL would throw away the
  // one thing that says whether the native CallKit fix is installed.
  it("never blanks a known build when a later registration omits it", async () => {
    await upsertPushToken(env.DB, { token: T, platform: "ios", staffEmail: EMAIL, now: 1, otaBuild: "67", nativeBuild: "5" });
    await upsertPushToken(env.DB, { token: T, platform: "ios", staffEmail: EMAIL, now: 2 });
    expect(await stored()).toMatchObject({ ota_build: "67", native_build: "5", last_seen: 2 });
  });

  // "" is a VALUE: it survives COALESCE and blanks the column just as destructively as NULL would.
  it("treats an empty or whitespace build as not sent at all", async () => {
    await upsertPushToken(env.DB, { token: T, platform: "ios", staffEmail: EMAIL, now: 1, otaBuild: "67", nativeBuild: "5" });
    await upsertPushToken(env.DB, { token: T, platform: "ios", staffEmail: EMAIL, now: 2, otaBuild: "", nativeBuild: "   " });
    expect(await stored()).toMatchObject({ ota_build: "67", native_build: "5" });
  });

  it("carries the builds through the register endpoint, capped so a client cannot store an essay", async () => {
    const res = await handleRegisterPushToken(
      new Request("https://x/api/push/register", {
        method: "POST",
        body: JSON.stringify({ token: T, platform: "ios", otaBuild: "67", nativeBuild: "9".repeat(100) }),
      }),
      env.DB,
      { email: EMAIL, role: "admin" }
    );
    expect(res.status).toBe(200);
    const row = await stored();
    expect(row?.ota_build).toBe("67");
    expect(row?.native_build?.length).toBe(32);
  });
});

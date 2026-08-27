import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyMissedCall, notifyVoicemail } from "../../src/api/push";
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

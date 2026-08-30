import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyInboundSms } from "../../src/api/push";

// Captures the message Expo would have been sent, so we can assert on the notification title.
function stubExpo() {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ status: "ok" }] }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function titleOf(fn: ReturnType<typeof stubExpo>): string {
  const body = JSON.parse(String(fn.mock.calls[0][1].body)) as { title: string }[];
  return body[0].title;
}

describe("inbound message notification titles", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await env.DB.prepare("DELETE FROM contacts").run();
    await env.DB.prepare(
      "INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES ('ExponentPushToken[abc]', 'ios', NULL, 1, 1)"
    ).run();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the resolved Facebook name when there is one", async () => {
    const fn = stubExpo();
    await notifyInboundSms(env.DB, "messenger:123", "hello", "Corey Allen");
    expect(titleOf(fn)).toBe("New message from Corey Allen");
  });

  // "New message from messenger:26199020283111854" is meaningless on a lock screen.
  it("falls back to the Facebook user placeholder rather than the raw psid", async () => {
    const fn = stubExpo();
    await notifyInboundSms(env.DB, "messenger:26199020283111854", "hello", null);
    expect(titleOf(fn)).toBe("New message from Facebook user");
  });

  it("still falls back to the raw number for an unknown SMS sender", async () => {
    const fn = stubExpo();
    await notifyInboundSms(env.DB, "+61400000000", "hello", null);
    expect(titleOf(fn)).toBe("New message from +61400000000");
  });
});

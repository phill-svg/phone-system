import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMessengerChannelHealth, CHANNEL_FAILURE_THRESHOLD } from "../../src/facebook/channelHealth";
import { getFbChannelAlertLastSent, setFbChannelAlertLastSent } from "../../src/db/settings";

const NOW = 1_800_000_000_000;

async function seedFailures(n: number, at = NOW - 60_000) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      "INSERT INTO messages (id, direction, peer_number, our_number, body, status, read, created_at) " +
        "VALUES (?, 'outbound', 'messenger:psid-1', 'messenger:page-1', 'hi', 'failed', 1, ?)"
    )
      .bind(`m-${i}-${at}`, at)
      .run();
  }
}

async function seedDevice() {
  await env.DB.prepare(
    "INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, ?, ?)"
  )
    .bind("ExponentPushToken[abc]", "a@b.com", NOW, NOW)
    .run();
}

function stubExpo() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    calls.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 });
  });
  return calls;
}

describe("checkMessengerChannelHealth", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM messages").run();
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await setFbChannelAlertLastSent(env.DB, 0);
  });
  afterEach(() => vi.unstubAllGlobals());

  // This fired on a count of ONE. Replying to a customer outside Meta's 24-hour window fails for
  // that recipient alone, and one of those raised "Facebook Messenger may be down" and then armed
  // the six-hour cooldown -- so a real channel break starting a minute later stayed silent until
  // the afternoon. Three in fifteen minutes is a pattern; one is a Tuesday.
  it("does not cry outage over a single failed message", async () => {
    await seedDevice();
    const calls = stubExpo();
    await seedFailures(CHANNEL_FAILURE_THRESHOLD - 1);
    await checkMessengerChannelHealth(env as never, NOW);
    expect(calls).toHaveLength(0);
    // And crucially it has NOT armed the cooldown, so a real break minutes later still alerts.
    expect(await getFbChannelAlertLastSent(env.DB)).toBe(0);
  });

  it("alerts once the failures look channel-wide", async () => {
    await seedDevice();
    const calls = stubExpo();
    await seedFailures(CHANNEL_FAILURE_THRESHOLD);
    await checkMessengerChannelHealth(env as never, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Facebook Messenger may be down");
    expect(await getFbChannelAlertLastSent(env.DB)).toBe(NOW);
  });

  it("stays quiet inside the cooldown", async () => {
    await seedDevice();
    const calls = stubExpo();
    await seedFailures(CHANNEL_FAILURE_THRESHOLD);
    await setFbChannelAlertLastSent(env.DB, NOW - 60_000);
    await checkMessengerChannelHealth(env as never, NOW);
    expect(calls).toHaveLength(0);
  });

  // Having nobody to tell is not the same as having told them. Stamping the cooldown anyway meant
  // an alert that reached no handset still suppressed the next six hours of them, so the outage
  // went unreported for a working day.
  it("does not arm the cooldown when there was no device to alert", async () => {
    const calls = stubExpo();
    await seedFailures(CHANNEL_FAILURE_THRESHOLD);
    await checkMessengerChannelHealth(env as never, NOW);
    expect(calls).toHaveLength(0);
    expect(await getFbChannelAlertLastSent(env.DB)).toBe(0);
  });
});

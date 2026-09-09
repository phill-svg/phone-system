import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetDiagnostics, handleTestPush, handleTestEmail, type Check } from "../../src/api/diagnostics";
import { recordDivertCallerIdRejection, clearDivertCallerIdRejection, setDivertCallerId } from "../../src/db/settings";

const ADMIN = { email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" as const };
const TOKEN = "ExponentPushToken[test-device-1]";

function baseEnv(extra: Record<string, unknown> = {}) {
  return { DB: env.DB, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", ...extra } as Parameters<typeof handleGetDiagnostics>[0];
}

// Routes by host so each test only says what differs from "everything healthy".
function stubFetch(over: { servicem8?: number; twilio?: number; region?: string | number; expo?: unknown } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("servicem8.com")) return Promise.resolve(new Response("{}", { status: over.servicem8 ?? 200 }));
    if (url.includes("routes.twilio.com")) {
      if (typeof over.region === "number") return Promise.resolve(new Response("{}", { status: over.region }));
      return Promise.resolve(new Response(JSON.stringify({ voice_region: over.region ?? "au1" }), { status: 200 }));
    }
    if (url.includes("api.sydney.au1.twilio.com")) {
      return Promise.resolve(new Response(JSON.stringify({ status: "active", friendly_name: "TCB" }), { status: over.twilio ?? 200 }));
    }
    if (url.includes("exp.host")) {
      return Promise.resolve(new Response(JSON.stringify(over.expo ?? { data: [{ status: "ok", id: "t1" }] }), { status: 200 }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function run(e = baseEnv()): Promise<Check[]> {
  const res = await handleGetDiagnostics(e, ADMIN);
  return res.json<Check[]>();
}

const find = (checks: Check[], key: string) => checks.find((c) => c.key === key)!;

describe("admin diagnostics", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await env.DB.prepare("DELETE FROM phone_numbers").run();
    await env.DB
      .prepare("INSERT INTO phone_numbers (e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region, created_at) VALUES ('+61261059771', 'Landline', 1, 0, 1, 0, 'au1', 1)")
      .run();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Tonight's outage: the key was never set, and nothing anywhere said so.
  it("reports a missing ServiceM8 key as a failure, distinctly from a rejected one", async () => {
    stubFetch();
    expect(find(await run(), "servicem8").detail).toContain("No API key set");
    expect(find(await run(), "servicem8").status).toBe("fail");

    stubFetch({ servicem8: 401 });
    const rejected = find(await run(baseEnv({ SERVICEM8_API_KEY: "bad" })), "servicem8");
    expect(rejected.status).toBe("fail");
    expect(rejected.detail).toContain("rejected");

    stubFetch();
    expect(find(await run(baseEnv({ SERVICEM8_API_KEY: "good" })), "servicem8").status).toBe("ok");
  });

  // The trap that cost a day: a voice number handled outside au1 takes calls nobody can answer.
  it("fails when a voice number is not in au1", async () => {
    stubFetch({ region: "us1" });
    const check = find(await run(), "regions");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("+61261059771");
    expect(check.detail).toContain("us1");
  });

  // A 404 from the routes API means no explicit config, which silently defaults to us1.
  it("treats a number with no region config as not-au1, because it defaults to us1", async () => {
    stubFetch({ region: 404 });
    const check = find(await run(), "regions");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("defaults to us1");
  });

  it("passes when every voice number is in au1", async () => {
    stubFetch();
    expect(find(await run(), "regions").status).toBe("ok");
  });

  it("fails the Twilio check on a 401, because nothing can dial without it", async () => {
    stubFetch({ twilio: 401 });
    expect(find(await run(), "twilio").status).toBe("fail");
  });

  it("reports the email binding as missing when it isn't wired", async () => {
    stubFetch();
    expect(find(await run(), "email").status).toBe("fail");
    stubFetch();
    const wired = find(await run(baseEnv({ EMAIL: { send: async () => {} } })), "email");
    expect(wired.status).toBe("ok");
  });

  // handleGetDiagnostics positionally destructures its Promise.all, so adding a check without a
  // binding shifts every one after it and drops the last off the end. That is not hypothetical: it
  // happened when the transcripts check was added, and it silently removed the push check while
  // every other assertion still passed.
  it("returns every check, with no key lost or duplicated", async () => {
    stubFetch();
    const keys = (await run()).map((c) => c.key);
    expect(keys).toEqual(["twilio", "regions", "roster", "divert_caller_id", "servicem8", "transcripts", "email", "push"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tells you when no device of yours is registered for push", async () => {
    stubFetch();
    expect(find(await run(), "push").status).toBe("fail");

    await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)").bind(TOKEN, ADMIN.email).run();
    stubFetch();
    const registered = find(await run(), "push");
    expect(registered.status).toBe("ok");
    expect(registered.detail).toContain("ios");
  });
});

describe("test push", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses with a useful message when the admin has no devices", async () => {
    const res = await handleTestPush(baseEnv(), ADMIN);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("No devices");
  });

  it("sends only to the caller's own devices, never a colleague's", async () => {
    await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)").bind(TOKEN, ADMIN.email).run();
    await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES ('ExponentPushToken[someone-else]', 'android', 'mate@example.com', 1, 1)").run();
    const fetchMock = stubFetch();
    const res = await handleTestPush(baseEnv(), ADMIN);
    expect(res.status).toBe(200);
    const sentBody = String(fetchMock.mock.calls[0][1]?.body);
    expect(sentBody).toContain("test-device-1");
    expect(sentBody).not.toContain("someone-else");
  });

  // A dead token means a phone that will never buzz; leaving it in the count is a lie.
  it("prunes a device Expo reports as dead", async () => {
    await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)").bind(TOKEN, ADMIN.email).run();
    stubFetch({ expo: { data: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] } });
    const res = await handleTestPush(baseEnv(), ADMIN);
    expect((await res.json<{ pruned: number }>()).pruned).toBe(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_tokens WHERE token = ?").bind(TOKEN).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("test email", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends to the caller's own address", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await handleTestEmail(baseEnv({ EMAIL: { send } }), ADMIN);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports the failure instead of pretending it sent", async () => {
    const res = await handleTestEmail(baseEnv(), ADMIN);
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toContain("Email failed");
  });

  // The divert fallback is invisible by design -- the phone still rings -- so a rejected caller ID
  // is only ever reported here.
  it("reports a rejected divert caller ID rather than leaving it to the logs", async () => {
    stubFetch();
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('divert_caller_id', 'divert_caller_id_last_error')").run();
    expect(find(await run(), "divert_caller_id").status).toBe("ok");

    await recordDivertCallerIdRejection(env.DB, 400);
    stubFetch();
    const failed = find(await run(), "divert_caller_id");
    expect(failed.status).toBe("fail");
    expect(failed.detail).toContain("400");

    // Switched off, a stale rejection is not a fault -- nothing is trying to use it.
    await setDivertCallerId(env.DB, false);
    stubFetch();
    expect(find(await run(), "divert_caller_id").status).toBe("ok");
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('divert_caller_id', 'divert_caller_id_last_error')").run();
  });

  // The half that matters for trust: the check has to come BACK. A marker that only ever gets set
  // pins this red for seven days while every divert works, and a check that cannot recover is one
  // people learn to ignore.
  it("reports healthy again once a working divert clears the marker", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('divert_caller_id', 'divert_caller_id_last_error')").run();
    await recordDivertCallerIdRejection(env.DB, 400);
    stubFetch();
    expect(find(await run(), "divert_caller_id").status).toBe("fail");

    await clearDivertCallerIdRejection(env.DB);
    stubFetch();
    expect(find(await run(), "divert_caller_id").status).toBe("ok");
  });
});

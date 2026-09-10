import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetDiagnostics, handleTestPush, handleTestEmail, type Check } from "../../src/api/diagnostics";
import { recordDivertCallerIdRejection, clearDivertCallerIdRejection, setDivertCallerId } from "../../src/db/settings";
import { setUserSettings } from "../../src/db/userSettings";

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
    expect(keys).toEqual(["twilio", "regions", "roster", "on_call", "divert_caller_id", "servicem8", "transcripts", "email", "push"]);
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

  describe("after-hours on call", () => {
    const CLOSED = JSON.stringify({ mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null });

    beforeEach(async () => {
      await env.DB.exec("DELETE FROM on_call_overrides");
      await env.DB.prepare("DELETE FROM settings WHERE key = 'on_call_rotation'").run();
      await env.DB.prepare("DELETE FROM staff_users WHERE email LIKE '%@oncall.test'").run();
      await env.DB.exec("DELETE FROM user_settings");
      await env.DB.exec("DELETE FROM ivr_nodes");
    });

    // A ring step that actually targets the rotation. Without one the rota is wired to nothing and
    // the check must say so -- which is the whole point of it, so most cases here seed it.
    // The production shape: an entry step whose CLOSED branch goes to the after-hours voicemail.
    // An empty ivr_nodes table is not "unwired" -- it is no phone menu at all, which the check
    // reports as unverifiable rather than blaming the rota.
    async function seedUnwiredFlow() {
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_hours', 'main', 1, 'business_hours', ?, 1, 1)")
        .bind(JSON.stringify({ openNextNodeId: "", closedNextNodeId: "n_vm" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_vm', 'main', 0, 'voicemail', ?, 1, 1)")
        .bind(JSON.stringify({ audioAssetId: null, ttsText: "", mailboxLabel: "after hours" }))
        .run();
    }

    async function wireIvrToOnCall() {
      // The ENTRY step, so the walk reaches it. A loose row would satisfy a row count and nothing
      // else, which is the bug these tests exist to hold shut.
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_ring', 'main', 1, 'ring', ?, 1, 1)")
        .bind(JSON.stringify({ target: "on_call", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" }))
        .run();
    }

    async function addTech(email: string) {
      await env.DB
        .prepare("INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, ring_priority) VALUES (?, 'staff', 1, 'available', ?, NULL, 100)")
        .bind(email, CLOSED)
        .run();
    }

    async function setRotation(members: string[]) {
      await env.DB
        .prepare("INSERT INTO settings (key, value) VALUES ('on_call_rotation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify({ members, anchorWeekStart: "2026-09-07" }))
        .run();
    }

    it("warns when nobody is on call at all", async () => {
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("straight to voicemail");
    });

    it("fails when the rotation names someone who has left", async () => {
      await setRotation(["departed@oncall.test"]);
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("departed@oncall.test");
    });

    // Still rings, but only the softphone -- the leg that depends on a backgrounded app waking up,
    // at the hour nobody is watching it.
    it("warns when the on-call tech has no mobile saved", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      // Wired, so this isolates the missing mobile. Unwired, the more severe failure reports first
      // and rightly so: with no step routing to the rotation the call reaches neither their mobile
      // nor their app, and "can only reach their app" would be actively wrong.
      await wireIvrToOnCall();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("no mobile number");
    });

    it("names who is on call and the number that will ring", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await wireIvrToOnCall();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("tech");
      expect(check.detail).toContain("+61412345678");
    });

    // The rota shipped INERT: main's closed branch was a voicemail node and nothing referenced
    // on_call at all. Without this the screen reports "tech is on call, ringing +61..." over a
    // feature wired to nothing, every after-hours caller keeps reaching voicemail, and the one
    // screen built to break that silence is the thing producing it.
    it("fails when no step of the phone menu rings the on-call person", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await seedUnwiredFlow();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("no step of the phone menu");
    });

    // A ring node that targets everyone is not the same as one targeting the rotation, and must
    // not satisfy the check.
    it("is not satisfied by a ring step that targets everyone", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_all', 'main', 1, 'ring', ?, 1, 1)")
        .bind(JSON.stringify({ target: "all", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" }))
        .run();
      stubFetch();
      expect(find(await run(), "on_call").status).toBe("fail");
    });

    // "Nobody is set" and "the stored rotation could not be read" are different instructions: one
    // sends you to Settings to do a thing, the other says the thing you already did is broken. The
    // first version of this test stored invalid JSON and asserted the UNDISTINGUISHED warn -- it
    // passed with the entire branch deleted, because getOnCallRotation laundered the corruption
    // into an empty rotation before the check ever saw it.
    it("reports a corrupt rotation as a failure, not as 'nobody is set'", async () => {
      await env.DB
        .prepare("INSERT INTO settings (key, value) VALUES ('on_call_rotation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind("not json at all")
        .run();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("cannot be read");
    });

    it("reports a wrong-shaped rotation the same way", async () => {
      await env.DB
        .prepare("INSERT INTO settings (key, value) VALUES ('on_call_rotation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify({ members: "not an array" }))
        .run();
      stubFetch();
      expect(find(await run(), "on_call").status).toBe("fail");
    });

    it("still says nobody is on call when nothing is stored at all", async () => {
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("Nobody is on call");
    });

    // The demo account is dropped at dial time, so a rotation naming it rings nobody. Reporting it
    // as fine was the same incident the write-path fix was supposed to close.
    it("does not report the demo account as on call", async () => {
      await addTech("reviewer@oncall.test");
      await setRotation(["reviewer@oncall.test"]);
      await setUserSettings(env.DB, "reviewer@oncall.test", { mobile_number: "0412345678" });
      await wireIvrToOnCall();
      stubFetch();
      const check = find(await run(baseEnv({ DEMO_ACCOUNT_EMAILS: "reviewer@oncall.test" })), "on_call");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("no longer a staff member");
    });

    // A ring step that EXISTS is not a ring step a call can REACH. Counting rows called this wired.
    it("is not satisfied by a ring step nothing routes to", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      // An entry step whose closed branch still goes to voicemail, plus an orphaned on-call ring
      // step sitting beside it -- exactly what saving a half-wired flow leaves behind.
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_hours', 'main', 1, 'business_hours', ?, 1, 1)")
        .bind(JSON.stringify({ openNextNodeId: "", closedNextNodeId: "n_vm" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_vm', 'main', 0, 'voicemail', ?, 1, 1)")
        .bind(JSON.stringify({ audioAssetId: null, ttsText: "", mailboxLabel: "after hours" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_orphan', 'main', 0, 'ring', ?, 1, 1)")
        .bind(JSON.stringify({ target: "on_call", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" }))
        .run();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("no step of the phone menu");
    });

    // And the positive: once the closed branch actually points at it, the same flow reports ok.

    // A ring step hung off the DAYTIME branch does not cover after hours, which is the one thing
    // this check exists to deny. flowEngine takes closedNextNodeId and only that when isAfterHours.
    it("is not satisfied by an on-call ring step on the open branch", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_hours', 'main', 1, 'business_hours', ?, 1, 1)")
        .bind(JSON.stringify({ openNextNodeId: "n_ring", closedNextNodeId: "n_vm" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_ring', 'main', 0, 'ring', ?, 1, 1)")
        .bind(JSON.stringify({ target: "on_call", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_vm', 'main', 0, 'voicemail', ?, 1, 1)")
        .bind(JSON.stringify({ audioAssetId: null, ttsText: "", mailboxLabel: "after hours" }))
        .run();
      stubFetch();
      expect(find(await run(), "on_call").status).toBe("fail");
    });

    // Node ids are a global primary key and flowEngine's loadNodeById has no flow predicate, so a
    // closed branch crossing into another flow is a supported shape -- and reporting that correctly
    // wired rota as unwired would have had someone dismantle a working configuration.
    it("follows a closed branch that crosses into another flow", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_hours', 'main', 1, 'business_hours', ?, 1, 1)")
        .bind(JSON.stringify({ openNextNodeId: "", closedNextNodeId: "n_ah_ring" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_ah_ring', 'after_hours', 0, 'ring', ?, 1, 1)")
        .bind(JSON.stringify({ target: "on_call", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" }))
        .run();
      stubFetch();
      expect(find(await run(), "on_call").status).toBe("ok");
    });

    // No entry node means every inbound call already fails -- the system is down, not missing a
    // menu step. Telling someone to add a ring step then would be the wrong emergency.
    it("does not blame the on-call wiring when the flow has no entry node", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_orphan', 'main', 0, 'voicemail', ?, 1, 1)")
        .bind(JSON.stringify({ audioAssetId: null, ttsText: "", mailboxLabel: "x" }))
        .run();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("could not be read");
    });

    // Both missing at once is the state production is actually in, and saying only half of it sends
    // someone round the loop twice.
    it("names both gaps when nobody is on call and nothing is wired", async () => {
      await seedUnwiredFlow();
      stubFetch();
      const check = find(await run(), "on_call");
      expect(check.detail).toContain("Nobody is on call");
      expect(check.detail).toContain("no step of the phone menu");
    });

    it("is satisfied once the closed branch routes to the on-call ring step", async () => {
      await addTech("tech@oncall.test");
      await setRotation(["tech@oncall.test"]);
      await setUserSettings(env.DB, "tech@oncall.test", { mobile_number: "0412345678" });
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_hours', 'main', 1, 'business_hours', ?, 1, 1)")
        .bind(JSON.stringify({ openNextNodeId: "", closedNextNodeId: "n_ring" }))
        .run();
      await env.DB
        .prepare("INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES ('n_ring', 'main', 0, 'ring', ?, 1, 1)")
        .bind(JSON.stringify({ target: "on_call", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" }))
        .run();
      stubFetch();
      expect(find(await run(), "on_call").status).toBe("ok");
    });
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

});

describe("divert caller ID", () => {
  afterEach(() => vi.restoreAllMocks());

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

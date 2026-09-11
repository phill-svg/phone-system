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
function stubFetch(
  over: {
    servicem8?: number;
    twilio?: number;
    region?: string | number;
    expo?: unknown;
    pushCred?: unknown;
    pushCredAndroid?: unknown;
  } = {}
) {
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
    // The au1 notify host, NOT notify.twilio.com. Matching on the full au1 hostname is the point:
    // push credentials are region-scoped, so a check that asked the us1 host would 404 every one of
    // this account's real credentials. Reverting the code to notify.twilio.com makes this stub throw
    // "unexpected fetch" rather than quietly passing.
    if (url.includes("notify.sydney.au1.twilio.com")) {
      // Routed by SID: the two platforms expect DIFFERENT credential types, so answering both with
      // one body made a healthy pair look broken. `pushCred` overrides the iOS credential only --
      // Android always answers a good fcm one, so a failure names the platform under test.
      if (url.includes("CRdroid")) {
        if (typeof over.pushCredAndroid === "number") {
          return Promise.resolve(new Response("{}", { status: over.pushCredAndroid }));
        }
        return Promise.resolve(new Response(JSON.stringify(over.pushCredAndroid ?? { type: "fcm" }), { status: 200 }));
      }
      if (typeof over.pushCred === "number") return Promise.resolve(new Response("{}", { status: over.pushCred }));
      return Promise.resolve(
        new Response(JSON.stringify(over.pushCred ?? { type: "apn", sandbox: "false" }), { status: 200 })
      );
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
    expect(keys).toEqual(["twilio", "regions", "roster", "on_call", "divert_caller_id", "servicem8", "transcripts", "email", "voip_push", "push"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The check used to count only rows with an `intelligence_sid`. A recording that comes back mono
  // is skipped BEFORE Twilio is asked, so it never gets one -- which made the single most likely
  // reason this feature does nothing invisible to the one screen that exists to say so. It reported
  // the reassuring "no answered call has been transcribed yet" instead, indefinitely.
  describe("speaker-labelled transcripts", () => {
    const ON = () => baseEnv({ TWILIO_INTELLIGENCE_SERVICE_SID: "GA-test" });

    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM calls WHERE id LIKE 'CA-diag-tr%'").run();
    });

    async function seed(id: string, status: string | null, sid: string | null) {
      await env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at, intelligence_status, intelligence_sid) VALUES (?, '+61400000000', '+61200000000', ?, ?, ?)"
      )
        .bind(id, Date.now(), status, sid)
        .run();
    }

    it("warns, without claiming a fault, when nothing is configured", async () => {
      stubFetch();
      const check = find(await run(), "transcripts");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("No Intelligence service set");
    });

    it("reports the dual-channel switch from a mono recording that HAS no transcript sid", async () => {
      // The whole point: sid NULL, status single_channel. Keyed on the sid, this row is invisible.
      await seed("CA-diag-tr-mono", "single_channel", null);
      stubFetch();
      const check = find(await run(ON()), "transcripts");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("Dual-channel Recording for Conference");
    });

    it("goes green again once a labelled transcript lands, without clearing the old mono rows", async () => {
      await seed("CA-diag-tr-mono2", "single_channel", null);
      await seed("CA-diag-tr-done", "completed", "GT1");
      stubFetch();
      const check = find(await run(ON()), "transcripts");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("1 labelled transcript");
    });

    it("says nothing has been transcribed yet when there is genuinely nothing to report", async () => {
      stubFetch();
      const check = find(await run(ON()), "transcripts");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("no answered call has been transcribed yet");
    });
  });

  // The native CallKit fix ships in a BINARY and can never arrive by OTA, so an old build on the
  // newest OTA is exactly the state that looks fine and is not: push registered, OTA current, no
  // crash recorded (no JavaScript runs when iOS kills the app), and the softphone simply never
  // rings. Before this, the only thing that could answer "is the fix installed?" was a line in the
  // handset's own Settings -- and that line was reading a property that does not exist.
  describe("which build a handset is running", () => {
    // `last_seen` is now load-bearing: a device nobody has opened in a month is not judged, so a
    // test device has to look like it checked in today rather than at the epoch.
    const register = (platform: string, ota: string | null, native: string | null, token = TOKEN, lastSeen = Date.now()) =>
      env.DB.prepare(
        "INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen, ota_build, native_build) VALUES (?, ?, ?, 1, ?, ?, ?)"
      )
        .bind(token, platform, ADMIN.email, lastSeen, ota, native)
        .run();

    it("fails an iPhone on a binary older than the CallKit fix", async () => {
      await register("ios", "67", "4");
      stubFetch();
      const check = find(await run(), "push");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("build 4");
      expect(check.detail).toContain("TestFlight");
    });

    it("passes an iPhone on the build that carries it", async () => {
      await register("ios", "67", "5");
      stubFetch();
      const check = find(await run(), "push");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("b5");
    });

    // Unknown is not the same as fine. A handset that has not re-registered cannot be cleared, and
    // reporting it as healthy is the exact silence this screen exists to break.
    it("warns rather than passing when an iPhone has not said which build it runs", async () => {
      await register("ios", null, null);
      stubFetch();
      const check = find(await run(), "push");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("has not reported");
    });

    // The rule is iOS-only: the AppDelegate patch is an iOS fix, and Android versionCodes are a
    // different number space entirely -- comparing them against 5 would fail every Android handset.
    it("does not judge an Android handset against the iOS build number", async () => {
      await register("android", "67", "2");
      stubFetch();
      expect(find(await run(), "push").status).toBe("ok");
    });

    // A build is client-supplied text, so it is not necessarily a number. `Number("1.0.4")` is NaN
    // and `NaN < 5` is false, so a bare comparison would silently CLEAR a handset it cannot judge --
    // the exact opposite of the rule this check states one block later.
    it("does not clear an iPhone whose build it cannot read", async () => {
      await register("ios", "67", "1.0.4");
      stubFetch();
      const check = find(await run(), "push");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("has not reported");
    });

    // A spare handset in a drawer is still installed and still holds a live token. Judging it would
    // pin this check red forever over a phone nobody answers calls on, and an alarm that never
    // clears is an alarm nobody reads.
    it("does not fail over a device nobody has opened in a month", async () => {
      const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
      await register("ios", "60", "4", TOKEN, sixtyDaysAgo);
      await register("ios", "67", "5", "ExponentPushToken[the-phone-in-use]");
      stubFetch();
      const check = find(await run(), "push");
      expect(check.status).toBe("ok");
      // Still listed, because hiding it would be its own kind of silence.
      expect(check.detail).toContain("b4");
    });

    // ...but if EVERY device is that old, "ok" would be a claim about nothing. Say so instead.
    it("warns when no device has checked in at all recently", async () => {
      await register("ios", "60", "5", TOKEN, Date.now() - 60 * 24 * 60 * 60 * 1000);
      stubFetch();
      const check = find(await run(), "push");
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("30 days");
    });
  });

  // The check that was missing on 2026-09-11, when a call rang the softphone for the full 22 and 62
  // seconds and the phone never stirred. mintAccessToken sets push_credential_sid only
  // `if (opts.pushCredentialSid)`, so an unset secret mints a valid token with no push credential:
  // the app registers happily and Twilio has no way to wake it. No error, no log, no crash.
  // Twilio issues credentials PER REGION. This account is AU1-homed, so TWILIO_AUTH_TOKEN is the
  // AU1 token -- and routes.twilio.com and notify.twilio.com are global (implicitly US1), where
  // that token is not a credential at all. The answer is 401 every time, forever. Reporting it as
  // "couldn't check" implies a blip that will clear on its own; it never will, and an amber row
  // with no next step is exactly the alarm people learn to ignore.
  describe("the AU1 / US1 credential split", () => {
    const US1 = { TWILIO_US1_API_KEY_SID: "SKus1", TWILIO_US1_API_KEY_SECRET: "shh" };
    const CREDS = { TWILIO_PUSH_CREDENTIAL_SID_IOS: "CRios", TWILIO_PUSH_CREDENTIAL_SID_ANDROID: "CRdroid" };

    // The outer beforeEach wipes this table and seeds the landline; these tests choose their own
    // numbers, so they clear it again rather than working around that seed.
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM phone_numbers").run();
    });

    async function seedNumber(e164: string, region: string | null) {
      await env.DB
        .prepare(
          "INSERT INTO phone_numbers (e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region, created_at) VALUES (?, 'Line', 1, 0, 1, 0, ?, 1)"
        )
        .bind(e164, region)
        .run();
    }

    it("explains a 401 on the region check instead of calling it a transient failure", async () => {
      await seedNumber("+61261059771", "au1");
      stubFetch({ region: 401 });
      const check = find(await run(), "regions");
      expect(check.detail).toContain("AU1 auth token");
      expect(check.detail).toContain("recorded as au1");
      expect(check.detail).not.toContain("Couldn't check:");
      // The status is half the finding: a number we could not verify but which is RECORDED as au1
      // is a warn, not a fail. Without this, inverting the recorded-region test leaves every other
      // assertion here green while the row turns red over a perfectly correct number.
      expect(check.status).toBe("warn");
    });

    // A number RECORDED as anything but au1, that we also cannot verify, is the dangerous case:
    // inbound calls to it are handled outside au1 where the softphone cannot be connected.
    it("fails, not warns, when the unverifiable number is recorded outside au1", async () => {
      await seedNumber("+61485034869", "us1");
      stubFetch({ region: 401 });
      const check = find(await run(), "regions");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("recorded as us1");
    });

    // Unknown is not known-bad. A number nobody ever recorded a region for may be sitting in au1;
    // failing on it would pin this row red and send someone to "fix" a Regional tab already right.
    // Both spellings of "no region": NULL, and the empty string a hand-edited D1 row can hold.
    // `?? null` lets "" through and "" is a value that reads as an answer -- the same trap already
    // recorded for the recording columns, which is why this goes through `blankToNull`.
    it.each([["null", null], ["empty", ""]])(
      "warns, not fails, when the unverifiable number has no region recorded (%s)",
      async (_label, region) => {
        await seedNumber("+61400000000", region);
        stubFetch({ region: 401 });
        const check = find(await run(), "regions");
        expect(check.status).toBe("warn");
        expect(check.detail).toContain("recorded as nothing");
      }
    );

    // First-match-wins used to drop a number entirely: once ANY number answered 401, one that had
    // timed out went unmentioned -- and the unmentioned one could be the one sitting in us1.
    it("mentions every number, even when they fail in different ways", async () => {
      await seedNumber("+61261059771", "au1");
      await seedNumber("+61400000001", "au1");
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("routes.twilio.com")) {
          return Promise.resolve(new Response("{}", { status: url.includes("400000001") ? 503 : 401 }));
        }
        if (url.includes("api.sydney.au1.twilio.com")) {
          return Promise.resolve(new Response(JSON.stringify({ status: "active" }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchMock);
      const check = find(await run(), "regions");
      expect(check.detail).toContain("+61261059771");
      expect(check.detail).toContain("+61400000001");
    });

    // The point of the whole exercise: the credential that CAN read this host is already in this
    // worker -- `sendSms` uses it, because the Messages API is US1-only too. A check that gives up
    // while holding the key is a permanently amber row, which is the alarm nobody reads.
    //
    // `routes.twilio.com` alone now, and the name says so: the push-credential lookup moved to the
    // au1 notify host on 2026-09-12, so a `notify.twilio.com` clause here would match nothing and
    // quietly overstate what this asserts.
    it("sends the US1 API key to the global routes host when it is configured", async () => {
      await seedNumber("+61261059771", "au1");
      const fetchMock = stubFetch();
      await run(baseEnv({ ...US1, ...CREDS }));
      const expected = `Basic ${btoa("SKus1:shh")}`;
      const globalCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("routes.twilio.com"));
      expect(globalCalls.length).toBeGreaterThan(0);
      for (const [, init] of globalCalls) {
        expect((init?.headers as Record<string, string>).Authorization).toBe(expected);
      }
      // ...and the au1 host still gets the au1 token, or nothing can dial.
      const au1Call = fetchMock.mock.calls.find(([input]) => String(input).includes("api.sydney.au1.twilio.com"))!;
      expect((au1Call[1]?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("AC123:tok")}`);
    });

    // The push-credential check no longer uses this split at all: it asks the au1 host with the au1
    // token, so a 401 there is a genuinely broken TWILIO_AUTH_TOKEN rather than a region artefact.
    // It must FAIL, not warn -- that same token validates every inbound webhook signature, so the
    // blast radius is far wider than one check, and a warn would bury it. The us1 split still
    // governs checkNumberRegions, which really does talk to a global host.
    it("fails loudly when the AU1 auth token itself is rejected, holding a US1 key or not", async () => {
      for (const e of [baseEnv({ ...US1, ...CREDS }), baseEnv(CREDS)]) {
        stubFetch({ pushCred: 401 });
        const check = find(await run(e), "voip_push");
        expect(check.status).toBe("fail");
        expect(check.detail).toContain("rejected the AU1 auth token");
        // A broken auth token is not a missing US1 key, and must not be reported as one.
        expect(check.detail).not.toContain("TWILIO_US1_API_KEY_SID");
        // It must not ASSERT the token is broken either. `checkTwilioCredentials` sends the same
        // AccountSid:AuthToken to api.sydney.au1.twilio.com in this same Promise.all, so those two
        // rows can disagree -- and the remedy this would otherwise name is the auth-token rotation,
        // which stops every inbound call if it is fumbled. It defers to the adjacent row instead.
        expect(check.detail).toContain("Twilio account check above");
      }
    });
  });

  describe("ringing the app", () => {
    const WITH_CREDS_VARS = { TWILIO_PUSH_CREDENTIAL_SID_IOS: "CRios", TWILIO_PUSH_CREDENTIAL_SID_ANDROID: "CRdroid" };
    const WITH_CREDS = () => baseEnv(WITH_CREDS_VARS);

    it("fails outright when no push credential is set at all", async () => {
      stubFetch();
      const check = find(await run(), "voip_push");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("never ring");
      expect(check.detail).toContain("TWILIO_PUSH_CREDENTIAL_SID_IOS");
    });

    it("fails when only iOS is missing, and names the platform", async () => {
      stubFetch();
      const check = find(await run(baseEnv({ TWILIO_PUSH_CREDENTIAL_SID_ANDROID: "CRdroid" })), "voip_push");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("iPhone");
    });

    // The phase-1 softphone design named this in its own words: "APNs environment mismatch
    // (sandbox vs production push credential) is a common cause of 'no incoming ring'". A
    // TestFlight build talks to PRODUCTION APNs, so a sandbox credential is pure silence.
    it("fails a SANDBOX APNs credential, which looks identical to everything working", async () => {
      stubFetch({ pushCred: { type: "apn", sandbox: "true" } });
      const check = find(await run(WITH_CREDS()), "voip_push");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("SANDBOX");
    });

    // A 404 from the AU1 host is the real never-rings condition: the access token sets twr:"au1"
    // and Twilio requires the token's push credential to exist in the token's own region, so a sid
    // that is absent there delivers no push whether it is a typo or a perfectly good US1 credential.
    //
    // The remedy must name the REGION. "Create it in Twilio" is what sent someone to the Console on
    // 2026-09-11 to make a second us1 credential that could never work -- the Console manages us1
    // only, and the au1 REST host is the one place these can be created.
    it("fails when the credential is absent from au1, and names the region in the remedy", async () => {
      stubFetch({ pushCred: 404 });
      const check = find(await run(WITH_CREDS()), "voip_push");
      expect(check.status).toBe("fail");
      expect(check.detail).toContain("does not exist in the au1 region");
      expect(check.detail).toContain("notify.sydney.au1.twilio.com");
      // Steering someone to the Console is the specific wrong turn this wording exists to prevent,
      // so it must say so explicitly rather than merely omitting it -- the Console is the obvious
      // place to go, and that is where the unusable second credential came from.
      expect(check.detail).toContain("NOT the Console");
    });

    // The credential lookup must go to the au1 host with the au1 token. Sending the US1 API key to
    // notify.twilio.com -- which is what this check did until 2026-09-12 -- 404s every credential
    // this account actually owns and reports working configuration as missing.
    it("asks the au1 notify host with the au1 auth token", async () => {
      const fetchMock = stubFetch({ pushCred: { type: "apn", sandbox: "false" } });
      await run(baseEnv({ ...WITH_CREDS_VARS, TWILIO_US1_API_KEY_SID: "SKus1", TWILIO_US1_API_KEY_SECRET: "shh" }));
      const calls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/v1/Credentials/"));
      expect(calls.length).toBe(2);
      for (const [input, init] of calls) {
        expect(String(input)).toContain("notify.sydney.au1.twilio.com");
        // The AU1 token even though a US1 key is present -- this host takes the regional credential.
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("AC123:tok")}`);
      }
    });

    // Each platform's verdict must attach to THAT platform. An Android-only failure sending someone
    // to re-check the APNs credential is the wrong turn -- this run just read it back as production.
    // The old version of this test asserted `not.toContain("confirm the APNs one is NOT sandbox")`,
    // a string the source no longer contains, so it could never fail: making the APNs flag
    // unconditional left all 57 tests green. Asserted on the real, current output instead.
    it("attributes each verdict to its own platform when only Android 404s", async () => {
      stubFetch({ pushCredAndroid: 404, pushCred: { type: "apn", sandbox: "false" } });
      const check = find(await run(WITH_CREDS()), "voip_push");
      expect(check.status).toBe("fail");
      // Android is named as the broken one, and iPhone as the healthy one -- not the reverse.
      expect(check.detail).toMatch(/Android: that credential does not exist in the au1 region/);
      expect(check.detail).toMatch(/iPhone: apn, production/);
      expect(check.detail).not.toMatch(/iPhone[^.]*does not exist/);
    });

    // A 401 must not carry a "now go and list them yourself with this credential" next step: the
    // credential it would hand over is the one Twilio just rejected, so following it reproduces the
    // 401. The 404 note already prints the host inline, so nothing needs appending there either.
    it("appends no by-hand retry step to a rejected credential", async () => {
      stubFetch({ pushCred: 401 });
      const check = find(await run(WITH_CREDS()), "voip_push");
      expect(check.detail).not.toContain("List them with");
      expect(check.detail).not.toContain("curl -u");
    });

    // Could-not-check is a warn, not a fail: a Twilio blip must not be reported as a broken
    // configuration and send someone rebuilding credentials that were fine.
    it("warns rather than failing when Twilio cannot be reached", async () => {
      stubFetch({ pushCred: 503 });
      expect(find(await run(WITH_CREDS()), "voip_push").status).toBe("warn");
    });

    it("passes a production APNs credential", async () => {
      stubFetch({ pushCred: { type: "apn", sandbox: "false" } });
      const check = find(await run(WITH_CREDS()), "voip_push");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("production");
    });
  });

  it("tells you when no device of yours is registered for push", async () => {
    stubFetch();
    expect(find(await run(), "push").status).toBe("fail");

    // Registered WITH its build, because an iOS handset that has not reported one is deliberately a
    // warn now rather than an ok -- see the build tests above. This half is about "a registered
    // device is found at all", so it gives the check nothing else to complain about.
    await env.DB.prepare(
      "INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen, ota_build, native_build) VALUES (?, 'ios', ?, 1, ?, '67', '5')"
    ).bind(TOKEN, ADMIN.email, Date.now()).run();
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

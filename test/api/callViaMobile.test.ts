import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCallViaMobile, normalizeDialTarget } from "../../src/api/callViaMobile";
import { setUserSettings } from "../../src/db/userSettings";

const STAFF = { email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" as const };
const MOBILE = "0472762158";
const MOBILE_E164 = "+61472762158";
const OFFICE = "+61261059771";

const passThroughSecret = (url: string) => url;

function testEnv() {
  return {
    DB: env.DB,
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_API_KEY_SID: "SK123",
    TWILIO_API_KEY_SECRET: "secret",
    TWILIO_FROM_NUMBER: "+61866108941",
    TWILIO_WEBHOOK_SECRET: "whsec",
  };
}

function req(body: unknown) {
  return new Request("https://example.com/api/softphone/call-via-mobile", { method: "POST", body: JSON.stringify(body) });
}

// Twilio's create-call endpoint, captured so the tests can assert what we asked it to do.
function stubTwilio() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ sid: "CAmobile1" }), { status: 201 }))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentParams(fetchMock: ReturnType<typeof stubTwilio>): URLSearchParams {
  return new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
}

describe("normalizeDialTarget", () => {
  it("accepts the forms staff actually dial", () => {
    expect(normalizeDialTarget("0402 430 107")).toBe("+61402430107");
    expect(normalizeDialTarget("(02) 6105 9771")).toBe("+61261059771");
    expect(normalizeDialTarget("+61402430107")).toBe("+61402430107");
    expect(normalizeDialTarget("1300 123 456")).toBe("+611300123456");
    expect(normalizeDialTarget("13 22 21")).toBe("+61132221");
    expect(normalizeDialTarget("1800 555 111")).toBe("+611800555111");
  });

  it("rejects anything that isn't dialable", () => {
    expect(normalizeDialTarget("")).toBeNull();
    expect(normalizeDialTarget("hello")).toBeNull();
    expect(normalizeDialTarget("12345")).toBeNull();
  });
});

describe("handleCallViaMobile", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings WHERE email = ?").bind(STAFF.email).run();
    await env.DB.prepare("DELETE FROM calls WHERE id = 'CAmobile1'").run();
    await env.DB.prepare("DELETE FROM phone_numbers").run();
    await env.DB
      .prepare("INSERT INTO phone_numbers (e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region, created_at) VALUES (?, 'Office', 1, 0, 1, 0, 'au1', 1)")
      .bind(OFFICE)
      .run();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses when no mobile number is saved, rather than silently doing nothing", async () => {
    stubTwilio();
    const res = await handleCallViaMobile(req({ to: "0402430107" }), testEnv(), STAFF, "https://example.com", passThroughSecret);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("mobile number");
  });

  it("rings YOUR mobile, not the customer, and shows the office number on it", async () => {
    await setUserSettings(env.DB, STAFF.email, { mobile_number: MOBILE });
    const fetchMock = stubTwilio();
    const res = await handleCallViaMobile(req({ to: "0402430107" }), testEnv(), STAFF, "https://example.com", passThroughSecret);
    expect(res.status).toBe(200);

    const params = sentParams(fetchMock);
    // The leg Twilio places is to the STAFF member. The customer is dialled later, by the TwiML.
    expect(params.get("To")).toBe(MOBILE_E164);
    expect(params.get("From")).toBe(OFFICE);
    expect(params.get("Url")).toContain("%2B61402430107"); // customer carried to the bridge webhook
  });

  // The one bad outcome: connecting a customer to a staff member's voicemail greeting.
  it("uses synchronous AMD on the staff leg so voicemail can be refused before the customer is dialled", async () => {
    await setUserSettings(env.DB, STAFF.email, { mobile_number: MOBILE });
    const fetchMock = stubTwilio();
    await handleCallViaMobile(req({ to: "0402430107" }), testEnv(), STAFF, "https://example.com", passThroughSecret);
    const params = sentParams(fetchMock);
    expect(params.get("MachineDetection")).toBe("Enable");
    // Async would hand back the verdict AFTER bridging, which is too late to refuse.
    expect(params.get("AsyncAmd")).toBeNull();
    expect(params.get("Timeout")).toBe("20");
  });

  it("logs the call under the mobile leg's SID so history and the status webhook just work", async () => {
    await setUserSettings(env.DB, STAFF.email, { mobile_number: MOBILE });
    stubTwilio();
    await handleCallViaMobile(req({ to: "0402430107" }), testEnv(), STAFF, "https://example.com", passThroughSecret);
    const row = await env.DB.prepare("SELECT caller_number, called_number, direction, status FROM calls WHERE id = 'CAmobile1'").first<{
      caller_number: string;
      called_number: string;
      direction: string;
      status: string;
    }>();
    expect(row).toMatchObject({ caller_number: OFFICE, called_number: "+61402430107", direction: "outbound", status: "in_progress" });
  });

  it("refuses to dial your own mobile, which would bridge you to yourself", async () => {
    await setUserSettings(env.DB, STAFF.email, { mobile_number: MOBILE });
    stubTwilio();
    const res = await handleCallViaMobile(req({ to: MOBILE }), testEnv(), STAFF, "https://example.com", passThroughSecret);
    expect(res.status).toBe(400);
  });

  it("rejects a number it can't dial without calling Twilio at all", async () => {
    await setUserSettings(env.DB, STAFF.email, { mobile_number: MOBILE });
    const fetchMock = stubTwilio();
    const res = await handleCallViaMobile(req({ to: "not a number" }), testEnv(), STAFF, "https://example.com", passThroughSecret);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

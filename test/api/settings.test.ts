import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handlePutBusinessHours,
  handlePutCallBlocklist,
  handleGetRecordingSetting,
  handlePutRecordingSetting,
  handleGetDivertCallerIdSetting,
  handlePutDivertCallerIdSetting,
  handleGetMissedCallSmsSetting,
  handlePutMissedCallSmsSetting,
} from "../../src/api/settings";
import { getCallBlocklist } from "../../src/db/settings";

const STAFF: import("../../src/access/requireStaffUser").StaffUser = {
  email: "tech@example.com",
  role: "staff",
};

describe("settings admin gating", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("handlePutBusinessHours returns 403 for a non-admin staff user", async () => {
    const request = new Request("https://example.com/api/settings/business-hours", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const response = await handlePutBusinessHours(request, env.DB, STAFF);
    expect(response.status).toBe(403);
  });
});

describe("handlePutCallBlocklist", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("rejects non-admins", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000"]) }),
      env.DB,
      { email: "staff@b.com", role: "staff" }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a non-array body", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ not: "an array" }) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(400);
  });

  it("rejects an array containing a non-string", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000", 5]) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(400);
  });

  it("saves a valid list for an admin", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000"]) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(200);
    expect(await getCallBlocklist(env.DB)).toEqual(["+61400000000"]);
  });
});

const admin = { email: "a@b.com", role: "admin" as const };
const staff = { email: "s@b.com", role: "staff" as const };
function putRec(body: unknown) {
  return new Request("https://x/api/settings/recording", { method: "PUT", body: JSON.stringify(body) });
}

function putDivert(body: unknown) {
  return new Request("https://x/api/settings/divert-caller-id", { method: "PUT", body: JSON.stringify(body) });
}

describe("/api/settings/divert-caller-id", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'divert_caller_id'").run();
  });
  // Default ON: knowing who is calling before you answer is the point of the feature.
  it("GET returns default true", async () => {
    expect(await (await handleGetDivertCallerIdSetting(env.DB)).json()).toEqual({ divert_caller_id: true });
  });
  it("admin PUT sets it; staff PUT is forbidden", async () => {
    expect((await handlePutDivertCallerIdSetting(putDivert({ divert_caller_id: false }), env.DB, admin)).status).toBe(200);
    expect(await (await handleGetDivertCallerIdSetting(env.DB)).json()).toEqual({ divert_caller_id: false });
    expect((await handlePutDivertCallerIdSetting(putDivert({ divert_caller_id: true }), env.DB, staff)).status).toBe(403);
  });
  it("rejects a non-boolean body rather than storing it", async () => {
    expect((await handlePutDivertCallerIdSetting(putDivert({ divert_caller_id: "yes" }), env.DB, admin)).status).toBe(400);
  });
});

function putMissedCallSms(body: unknown) {
  return new Request("https://x/api/settings/missed-call-sms", { method: "PUT", body: JSON.stringify(body) });
}

describe("/api/settings/missed-call-sms", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'missed_call_sms'").run();
  });
  // Off by default: texting every caller who doesn't get through is a real behaviour change to a
  // customer relationship, not a safe default.
  it("GET returns disabled with a default template", async () => {
    const body = await (await handleGetMissedCallSmsSetting(env.DB)).json<{ enabled: boolean; template: string }>();
    expect(body.enabled).toBe(false);
    expect(body.template.length).toBeGreaterThan(0);
  });
  it("admin PUT sets it; staff PUT is forbidden", async () => {
    expect(
      (await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: true, template: "sorry we missed you" }), env.DB, admin)).status
    ).toBe(200);
    expect(await (await handleGetMissedCallSmsSetting(env.DB)).json()).toEqual({ enabled: true, template: "sorry we missed you" });
    expect(
      (await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: false, template: "x" }), env.DB, staff)).status
    ).toBe(403);
  });
  it("rejects a malformed body rather than storing it", async () => {
    expect((await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: "yes", template: "x" }), env.DB, admin)).status).toBe(400);
    expect((await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: true, template: 5 }), env.DB, admin)).status).toBe(400);
  });
  // Turning it on with nothing to send would silently never text anyone -- refuse it at save time
  // instead, the same reasoning as every other "validate on write" rule in this codebase.
  it("refuses to enable with a blank template", async () => {
    const res = await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: true, template: "   " }), env.DB, admin);
    expect(res.status).toBe(400);
  });
  it("allows saving a blank template while disabled", async () => {
    const res = await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: false, template: "   " }), env.DB, admin);
    expect(res.status).toBe(200);
  });
  it("rejects a template over the length cap", async () => {
    const res = await handlePutMissedCallSmsSetting(putMissedCallSms({ enabled: true, template: "x".repeat(321) }), env.DB, admin);
    expect(res.status).toBe(400);
  });
});

describe("/api/settings/recording", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'recording_enabled'").run();
  });
  it("GET returns default true", async () => {
    expect(await (await handleGetRecordingSetting(env.DB)).json()).toEqual({ recording_enabled: true });
  });
  it("admin PUT sets it; staff PUT is forbidden", async () => {
    expect((await handlePutRecordingSetting(putRec({ recording_enabled: false }), env.DB, admin)).status).toBe(200);
    expect(await (await handleGetRecordingSetting(env.DB)).json()).toEqual({ recording_enabled: false });
    expect((await handlePutRecordingSetting(putRec({ recording_enabled: true }), env.DB, staff)).status).toBe(403);
  });
});

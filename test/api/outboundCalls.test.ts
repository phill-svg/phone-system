import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker";
import { handleCreateOutboundCall } from "../../src/api/outboundCalls";
import type { StaffUser } from "../../src/access/requireStaffUser";

const STAFF_WITH_MOBILE: StaffUser = { email: "tech@example.com", role: "staff", mobile_number: "+61411111111" };
const STAFF_NO_MOBILE: StaffUser = { email: "tech2@example.com", role: "staff", mobile_number: null };

describe("handleCreateOutboundCall", () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns 400 when the body is missing `to`", async () => {
    const request = new Request("https://example.com/api/calls/outbound", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const response = await handleCreateOutboundCall(request, env as any, STAFF_WITH_MOBILE);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid request body");
  });

  it("returns 400 when `to` is not a non-empty string", async () => {
    const request = new Request("https://example.com/api/calls/outbound", {
      method: "POST",
      body: JSON.stringify({ to: "" }),
    });
    const response = await handleCreateOutboundCall(request, env as any, STAFF_WITH_MOBILE);
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-JSON body", async () => {
    const request = new Request("https://example.com/api/calls/outbound", {
      method: "POST",
      body: "not json",
    });
    const response = await handleCreateOutboundCall(request, env as any, STAFF_WITH_MOBILE);
    expect(response.status).toBe(400);
  });

  it("returns 400 when the staff account has no mobile_number on file", async () => {
    const request = new Request("https://example.com/api/calls/outbound", {
      method: "POST",
      body: JSON.stringify({ to: "+61400000099" }),
    });
    const response = await handleCreateOutboundCall(request, env as any, STAFF_NO_MOBILE);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("no mobile number on file for this staff account");
    // Must not have called out to Twilio at all.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on success: dials the staff mobile via createOutboundCall, inserts the calls row, returns 201", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "CA-outbound-1" }), { status: 201 }));

    const request = new Request("https://example.com/api/calls/outbound", {
      method: "POST",
      body: JSON.stringify({ to: "+61400000099" }),
    });
    const response = await handleCreateOutboundCall(request, env as any, STAFF_WITH_MOBILE);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "CA-outbound-1" });

    // Verify the Twilio REST call was made with the right To/From/Url.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("To")).toBe(STAFF_WITH_MOBILE.mobile_number);
    expect(body.get("From")).toBe(env.TWILIO_FROM_NUMBER);
    expect(body.get("Url")).toBe(
      "https://example.com/webhooks/twilio/click-to-call?target=" + encodeURIComponent("+61400000099")
    );

    // Verify the calls row.
    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ?")
      .bind("CA-outbound-1")
      .first<{
        caller_number: string;
        called_number: string;
        is_after_hours: number;
        status: string;
        direction: string;
      }>();
    expect(row?.caller_number).toBe(env.TWILIO_FROM_NUMBER);
    expect(row?.called_number).toBe("+61400000099");
    expect(row?.is_after_hours).toBe(0);
    expect(row?.status).toBe("in_progress");
    expect(row?.direction).toBe("outbound");
  });
});

describe("POST /api/calls/outbound auth gating (via the real worker route)", () => {
  it("401s in a production-auth env with no Cf-Access-Jwt-Assertion header", async () => {
    const prodEnv = {
      DB: env.DB,
      CALL_SESSION: env.CALL_SESSION,
      AUDIO_ASSETS: env.AUDIO_ASSETS,
      TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
      // No AUTH_MODE / DEV_STAFF_EMAIL: this is what production actually looks like.
      CF_ACCESS_TEAM_DOMAIN: "tcb-pest.cloudflareaccess.com",
      CF_ACCESS_AUD: "prod-aud-tag",
    };

    const response = await worker.fetch(
      new Request("https://example.com/api/calls/outbound", {
        method: "POST",
        body: JSON.stringify({ to: "+61400000099" }),
      }),
      prodEnv as any
    );
    expect(response.status).toBe(401);
  });

  it("routes an authenticated POST through to handleCreateOutboundCall, not the /api/calls/:id regex", async () => {
    // Regression guard: /api/calls/outbound must be matched BEFORE the /api/calls/:id regex
    // (which would otherwise treat "outbound" as an id and dispatch to handleCallDetail
    // instead). The dev-mode pool default staff (phill) has no mobile_number on file, so a
    // correctly-routed request 400s with this exact message; a misrouted one would instead
    // 404 (handleCallDetail finds no call with id "outbound").
    const response = await SELF.fetch("https://example.com/api/calls/outbound", {
      method: "POST",
      body: JSON.stringify({ to: "+61400000099" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("no mobile number on file for this staff account");
  });

  it("403s (not provisioned) for a dev-mode staff email absent from staff_users", async () => {
    const devEnvUnprovisioned = {
      DB: env.DB,
      CALL_SESSION: env.CALL_SESSION,
      AUDIO_ASSETS: env.AUDIO_ASSETS,
      TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
      AUTH_MODE: "dev",
      DEV_STAFF_EMAIL: "not-a-real-staff-member@example.com",
    };

    const response = await worker.fetch(
      new Request("https://example.com/api/calls/outbound", {
        method: "POST",
        body: JSON.stringify({ to: "+61400000099" }),
      }),
      devEnvUnprovisioned as any
    );
    expect(response.status).toBe(403);
  });
});

import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { env } from "cloudflare:test";
import { handleGetSoftphoneToken, handlePutPresence, handlePostHeartbeat } from "../../src/api/softphone";

describe("handleGetSoftphoneToken", () => {
  it("returns a token scoped to the requesting staff member's identity", async () => {
    const env = {
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_API_KEY_SID: "SKxxx",
      TWILIO_API_KEY_SECRET: "shh",
      TWILIO_TWIML_APP_SID: "APxxx",
    };
    const res = await handleGetSoftphoneToken(env, { email: "a@b.com", role: "staff" });
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    const { payload } = await jwtVerify(token, new TextEncoder().encode("shh"));
    expect((payload.grants as any).identity).toBe("a@b.com");
  });
});

describe("handlePutPresence", () => {
  it("rejects an invalid status", async () => {
    const res = await handlePutPresence(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ status: "busy" }) }),
      env.DB,
      { email: "a@b.com", role: "staff" }
    );
    expect(res.status).toBe(400);
  });

  it("updates the caller's own status and awayReason", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const res = await handlePutPresence(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ status: "away", awayReason: "lunch" }) }),
      env.DB,
      { email: "a@b.com", role: "staff" }
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, away_reason FROM staff_users WHERE email = 'a@b.com'").first();
    expect(row).toEqual({ status: "away", away_reason: "lunch" });
  });
});

describe("handlePostHeartbeat", () => {
  it("touches the caller's own heartbeat", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const before = Date.now();
    const res = await handlePostHeartbeat(env.DB, { email: "a@b.com", role: "staff" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT last_heartbeat_at FROM staff_users WHERE email = 'a@b.com'").first<{ last_heartbeat_at: number }>();
    expect(row!.last_heartbeat_at).toBeGreaterThanOrEqual(before);
  });
});

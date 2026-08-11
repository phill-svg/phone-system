import { describe, it, expect, vi } from "vitest";
import { jwtVerify } from "jose";
import { env } from "cloudflare:test";
import {
  handleGetSoftphoneToken,
  handlePutPresence,
  handlePostHeartbeat,
  handlePostHold,
  handlePostTransfer,
  handlePostCompleteTransfer,
} from "../../src/api/softphone";

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

describe("handlePostHold", () => {
  it("looks up the conference and sets Hold on the OTHER participant, not the caller's own leg", async () => {
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }, { callSid: "CAother" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(200);
    expect(findSid).toHaveBeenCalledWith("ACxxx", "authtoken", "CAcaller");
    expect(setHold).toHaveBeenCalledTimes(1);
    expect(setHold).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAother", true);
  });

  it("404s when the conference can't be found", async () => {
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: vi.fn().mockResolvedValue(null), listParticipants: vi.fn(), setParticipantHold: vi.fn() }
    );
    expect(res.status).toBe(404);
  });

  it("does nothing when the caller is the only participant in the conference so far", async () => {
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(200);
    expect(setHold).not.toHaveBeenCalled();
  });
});

describe("handlePostTransfer", () => {
  it("dials the target identity into the same conference and returns the new leg's sid", async () => {
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const res = await handlePostTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", targetEmail: "b@b.com" }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken", TWILIO_FROM_NUMBER: "+61800000000" },
      { email: "a@b.com", role: "staff" },
      "https://example.com",
      { createOutboundCall: dial }
    );
    expect(res.status).toBe(200);
    expect(dial).toHaveBeenCalledWith(
      "ACxxx", "authtoken",
      expect.objectContaining({
        to: "client:b@b.com",
        from: "+61800000000",
        url: "https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller",
      })
    );
    expect(await res.json()).toEqual({ sid: "CAtransfer" });
  });
});

describe("handlePostCompleteTransfer", () => {
  it("looks up the conference and removes the given participant", async () => {
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAoriginalAgent" }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: findSid, removeParticipant: remove }
    );
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAoriginalAgent");
  });
});

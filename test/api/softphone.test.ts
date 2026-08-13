import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { recordCallLeg } from "../../src/db/callLegs";

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
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM softphone_call_legs`);
  });

  it("looks up the conference and sets Hold on the OTHER participant, not the caller's own leg", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }, { callSid: "CAother" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
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
      env.DB,
      { findConferenceSid: vi.fn().mockResolvedValue(null), listParticipants: vi.fn(), setParticipantHold: vi.fn() }
    );
    expect(res.status).toBe(404);
  });

  it("does nothing when the caller is the only participant in the conference so far", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(200);
    expect(setHold).not.toHaveBeenCalled();
  });

  it("403s when the requester's selfCallSid is not actually a participant in the conference (still owns the leg)", async () => {
    await recordCallLeg(env.DB, "CAnotamember", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAother1" }, { callSid: "CAother2" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAnotamember", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(403);
    expect(setHold).not.toHaveBeenCalled();
  });

  it("403s when selfCallSid is a genuine conference participant but was recorded under a DIFFERENT staff member's identity", async () => {
    // The attack this closes: staff member "a@b.com" reads a colleague's live-call CallSid
    // (via GET /api/calls/live) and submits it as their own selfCallSid. It IS a real
    // participant in the conference, but it was dialed/received on behalf of "victim@b.com".
    await recordCallLeg(env.DB, "CAself", "victim@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }, { callSid: "CAother" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(403);
    expect(listParticipants).not.toHaveBeenCalled();
    expect(setHold).not.toHaveBeenCalled();
  });

  it("403s when selfCallSid was never recorded as anyone's leg at all", async () => {
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }, { callSid: "CAother" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(403);
    expect(listParticipants).not.toHaveBeenCalled();
    expect(setHold).not.toHaveBeenCalled();
  });
});

describe("handlePostTransfer", () => {
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM softphone_call_legs`);
  });

  it("dials the target identity into the same conference and returns the new leg's sid", async () => {
    await recordCallLeg(env.DB, "CAagent", "a@b.com", "CAcaller");
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAagent" }, { callSid: "CAcaller" }]);
    const res = await handlePostTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", targetEmail: "b@b.com", agentCallSid: "CAagent" }),
      }),
      {
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "authtoken",
        TWILIO_API_KEY_SID: "SKxxx",
        TWILIO_API_KEY_SECRET: "authtoken",
        TWILIO_FROM_NUMBER: "+61800000000",
      },
      { email: "a@b.com", role: "staff" },
      "https://example.com",
      env.DB,
      { createOutboundCall: dial, findConferenceSid: findSid, listParticipants }
    );
    expect(res.status).toBe(200);
    expect(dial).toHaveBeenCalledWith(
      "ACxxx", "SKxxx", "authtoken",
      expect.objectContaining({
        to: "client:b@b.com",
        from: "+61800000000",
        url: "https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller",
      })
    );
    expect(await res.json()).toEqual({ sid: "CAtransfer" });
  });

  it("records the transferred-to leg's ownership for the target staff member after a successful dial", async () => {
    await recordCallLeg(env.DB, "CAagent", "a@b.com", "CAcaller");
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAagent" }, { callSid: "CAcaller" }]);
    await handlePostTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", targetEmail: "b@b.com", agentCallSid: "CAagent" }),
      }),
      {
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "authtoken",
        TWILIO_API_KEY_SID: "SKxxx",
        TWILIO_API_KEY_SECRET: "authtoken",
        TWILIO_FROM_NUMBER: "+61800000000",
      },
      { email: "a@b.com", role: "staff" },
      "https://example.com",
      env.DB,
      { createOutboundCall: dial, findConferenceSid: findSid, listParticipants }
    );
    const row = await env.DB.prepare("SELECT * FROM softphone_call_legs WHERE call_sid = 'CAtransfer'").first<{
      staff_email: string;
      conference_name: string;
    }>();
    expect(row).toMatchObject({ staff_email: "b@b.com", conference_name: "CAcaller" });
  });

  it("403s when agentCallSid isn't actually a participant in the named conference (still owns the leg)", async () => {
    await recordCallLeg(env.DB, "CAnotamember", "a@b.com", "CAcaller");
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAcaller" }, { callSid: "CAother" }]);
    const res = await handlePostTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", targetEmail: "b@b.com", agentCallSid: "CAnotamember" }),
      }),
      {
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "authtoken",
        TWILIO_API_KEY_SID: "SKxxx",
        TWILIO_API_KEY_SECRET: "authtoken",
        TWILIO_FROM_NUMBER: "+61800000000",
      },
      { email: "a@b.com", role: "staff" },
      "https://example.com",
      env.DB,
      { createOutboundCall: dial, findConferenceSid: findSid, listParticipants }
    );
    expect(res.status).toBe(403);
    expect(dial).not.toHaveBeenCalled();
  });

  it("403s when agentCallSid is a genuine conference participant but was recorded under a DIFFERENT staff member's identity", async () => {
    await recordCallLeg(env.DB, "CAagent", "victim@b.com", "CAcaller");
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAagent" }, { callSid: "CAcaller" }]);
    const res = await handlePostTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", targetEmail: "b@b.com", agentCallSid: "CAagent" }),
      }),
      {
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "authtoken",
        TWILIO_API_KEY_SID: "SKxxx",
        TWILIO_API_KEY_SECRET: "authtoken",
        TWILIO_FROM_NUMBER: "+61800000000",
      },
      { email: "a@b.com", role: "staff" },
      "https://example.com",
      env.DB,
      { createOutboundCall: dial, findConferenceSid: findSid, listParticipants }
    );
    expect(res.status).toBe(403);
    expect(listParticipants).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  });
});

describe("handlePostCompleteTransfer", () => {
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM softphone_call_legs`);
  });

  it("looks up the conference and removes the given participant", async () => {
    await recordCallLeg(env.DB, "CAoriginalAgent", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAoriginalAgent" }, { callSid: "CAcaller" }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAoriginalAgent", selfCallSid: "CAoriginalAgent" }),
      }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, removeParticipant: remove }
    );
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAoriginalAgent");
  });

  it("403s when selfCallSid isn't actually a participant in the named conference (still owns the leg)", async () => {
    await recordCallLeg(env.DB, "CAnotamember", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAcaller" }, { callSid: "CAother" }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAoriginalAgent", selfCallSid: "CAnotamember" }),
      }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, removeParticipant: remove }
    );
    expect(res.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  it("403s when selfCallSid is a genuine conference participant but was recorded under a DIFFERENT staff member's identity", async () => {
    await recordCallLeg(env.DB, "CAoriginalAgent", "victim@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAoriginalAgent" }, { callSid: "CAcaller" }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAoriginalAgent", selfCallSid: "CAoriginalAgent" }),
      }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, removeParticipant: remove }
    );
    expect(res.status).toBe(403);
    expect(listParticipants).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

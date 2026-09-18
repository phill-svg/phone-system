import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
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

  // An inbound call's conference is named after the CALLER's leg (CallSession.dialStaff), which a
  // handset does not know. The web sent its own leg sid and got "conference not found" on every
  // inbound hold. The leg row already records the real conference, so that is the one to use.
  it("finds an inbound call's conference from the leg record, not the client's guess", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAself" }, { callSid: "CAcaller" }]);
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAself", selfCallSid: "CAself", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: findSid, listParticipants, setParticipantHold: setHold }
    );
    expect(res.status).toBe(200);
    expect(findSid).toHaveBeenCalledWith("ACxxx", "authtoken", "CAcaller");
    expect(setHold).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAcaller", true);
  });

  it("404s when the conference can't be found", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
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

  // The transferred-to staff member sees this caller ID, and it comes from phone_numbers like every
  // other outbound leg -- NOT from TWILIO_FROM_NUMBER, which still holds the number this system was
  // built on and stopped being the business's caller ID when the landline ported in. The env value
  // survives only as a fallback for an empty table, which is why it is deliberately a different
  // number here.
  it("dials the target identity into the same conference and returns the new leg's sid", async () => {
    await recordCallLeg(env.DB, "CAagent", "a@b.com", "CAcaller");
    await env.DB.prepare("UPDATE phone_numbers SET is_default_voice = 0").run();
    await env.DB.prepare(
      "INSERT INTO phone_numbers (e164, label, voice_enabled, sms_enabled, is_default_voice, is_default_sms, region, created_at) VALUES ('+61261059771', 'Landline', 1, 0, 1, 0, 'au1', 1)"
    ).run();
    // Undone at the end of the test: this table is not in any beforeEach, so a leaked default would
    // silently change what every later test resolves.
    onTestFinished(async () => {
      await env.DB.prepare("DELETE FROM phone_numbers WHERE e164 = '+61261059771'").run();
      await env.DB.prepare("UPDATE phone_numbers SET is_default_voice = 1 WHERE e164 = '+61866108941'").run();
    });
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
        // CallerNumber rides along so the mobile app's native call-notification template (see
        // setIncomingCallContactHandleTemplate in mobile/src/lib/voice.ts) always resolves --
        // here it's the business number, matching what the colleague would see without it.
        to: "client:b@b.com?CallerNumber=61261059771&CallerName=61261059771",
        from: "+61261059771",
        url: "https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller",
      })
    );
    expect(await res.json()).toEqual({ sid: "CAtransfer" });
  });

  // Same defect as hold: an inbound call's conference is named after the CALLER's leg, which a handset
  // does not know. Trusting the client's name dialled the colleague into a conference nobody was in.
  it("dials the colleague into the conference from the leg record, not the client's guess", async () => {
    await recordCallLeg(env.DB, "CAagent", "a@b.com", "CAcaller");
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAagent" }, { callSid: "CAcaller" }]);
    const res = await handlePostTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAagent", targetEmail: "b@b.com", agentCallSid: "CAagent" }),
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
    expect(findSid).toHaveBeenCalledWith("ACxxx", "authtoken", "CAcaller");
    expect(dial).toHaveBeenCalledWith(
      "ACxxx", "SKxxx", "authtoken",
      expect.objectContaining({ url: "https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller" })
    );
    const row = await env.DB.prepare("SELECT conference_name FROM softphone_call_legs WHERE call_sid = 'CAtransfer'").first();
    expect(row).toEqual({ conference_name: "CAcaller" });
  });

  // The handset sends no conferenceName at all, exactly as it does for hold.
  it("accepts a request with no conferenceName", async () => {
    await recordCallLeg(env.DB, "CAagent", "a@b.com", "CAcaller");
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const res = await handlePostTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ targetEmail: "b@b.com", agentCallSid: "CAagent" }) }),
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
      {
        createOutboundCall: dial,
        findConferenceSid: vi.fn().mockResolvedValue("CFxxx"),
        listParticipants: vi.fn().mockResolvedValue([{ callSid: "CAagent" }, { callSid: "CAcaller" }]),
      }
    );
    expect(res.status).toBe(200);
    expect(dial).toHaveBeenCalledTimes(1);
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
    const listParticipants = vi.fn().mockResolvedValue([{ callSid: "CAoriginalAgent" }, { callSid: "CAcaller" }, { callSid: "CAtransfer" }]);
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

  // The only leg a staff member may remove is their OWN. `callSid` used to be removed as given, so a
  // requester holding a real leg could name the CUSTOMER's sid and hang up on them.
  it("removes the requester's own leg even when the body names someone else's", async () => {
    await recordCallLeg(env.DB, "CAoriginalAgent", "a@b.com", "CAcaller");
    const listParticipants = vi
      .fn()
      .mockResolvedValue([{ callSid: "CAoriginalAgent" }, { callSid: "CAcaller" }, { callSid: "CAtransfer" }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAcaller", selfCallSid: "CAoriginalAgent" }),
      }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      { findConferenceSid: vi.fn().mockResolvedValue("CFxxx"), listParticipants, removeParticipant: remove }
    );
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAoriginalAgent");
  });

  // An inbound call's conference is named after the caller's leg; the handset sends only its own sid.
  it("finds the conference from the leg record when the client sends only its own sid", async () => {
    await recordCallLeg(env.DB, "CAoriginalAgent", "a@b.com", "CAcaller");
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ selfCallSid: "CAoriginalAgent" }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      {
        findConferenceSid: findSid,
        listParticipants: vi.fn().mockResolvedValue([{ callSid: "CAoriginalAgent" }, { callSid: "CAcaller" }, { callSid: "CAtransfer" }]),
        removeParticipant: remove,
      }
    );
    expect(res.status).toBe(200);
    expect(findSid).toHaveBeenCalledWith("ACxxx", "authtoken", "CAcaller");
    expect(remove).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAoriginalAgent");
  });

  // Leaving before the colleague has joined leaves the customer alone, and cleanupLoneConference then
  // ends the conference on them. Refuse instead: the colleague is not a participant until they answer.
  it("409s rather than drop the customer when the colleague has not joined yet", async () => {
    await recordCallLeg(env.DB, "CAoriginalAgent", "a@b.com", "CAcaller");
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ selfCallSid: "CAoriginalAgent" }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      env.DB,
      {
        findConferenceSid: vi.fn().mockResolvedValue("CFxxx"),
        listParticipants: vi.fn().mockResolvedValue([{ callSid: "CAoriginalAgent" }, { callSid: "CAcaller" }]),
        removeParticipant: remove,
      }
    );
    expect(res.status).toBe(409);
    expect(remove).not.toHaveBeenCalled();
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

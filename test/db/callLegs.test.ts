import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { recordCallLeg, ownLegConference } from "../../src/db/callLegs";

describe("softphone call-leg ownership records", () => {
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM softphone_call_legs`);
  });

  it("recordCallLeg inserts a row recording which staff email owns a CallSid", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    const row = await env.DB.prepare("SELECT * FROM softphone_call_legs WHERE call_sid = ?")
      .bind("CAself")
      .first<{ call_sid: string; staff_email: string; conference_name: string; created_at: number }>();
    expect(row).toMatchObject({
      call_sid: "CAself",
      staff_email: "a@b.com",
      conference_name: "CAcaller",
    });
    expect(row?.created_at).toBeGreaterThan(0);
  });

  it("recordCallLeg is a no-op when the CallSid is already recorded (ON CONFLICT DO NOTHING)", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    await recordCallLeg(env.DB, "CAself", "someone-else@b.com", "CAother");
    const row = await env.DB.prepare("SELECT staff_email, conference_name FROM softphone_call_legs WHERE call_sid = ?")
      .bind("CAself")
      .first<{ staff_email: string; conference_name: string }>();
    expect(row).toEqual({ staff_email: "a@b.com", conference_name: "CAcaller" });
  });

  it("ownLegConference returns the leg's conference when the CallSid is recorded under the given staff email", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    expect(await ownLegConference(env.DB, "CAself", "a@b.com")).toBe("CAcaller");
  });

  it("ownLegConference returns null when the CallSid is recorded under a DIFFERENT staff email", async () => {
    await recordCallLeg(env.DB, "CAself", "a@b.com", "CAcaller");
    expect(await ownLegConference(env.DB, "CAself", "attacker@b.com")).toBeNull();
  });

  it("ownLegConference returns null when the CallSid was never recorded", async () => {
    expect(await ownLegConference(env.DB, "CAnonexistent", "a@b.com")).toBeNull();
  });
});

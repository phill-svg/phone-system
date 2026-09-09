import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../../src/access/session";
import { issueToken } from "../../src/access/passwordTokens";
import { handleInviteStaff, handleSendReset, handleRemoveStaff } from "../../src/api/staff";
import { setUserSettings } from "../../src/db/userSettings";

// The pool authenticates every SELF.fetch as phill (admin) via AUTH_MODE=dev.
const NEW = "invitee@example.com";
const ADMIN = { email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" as const };

// Email sends via the Cloudflare send_email binding, which miniflare can't provide — so the
// invite/reset paths that send email are exercised at the handler level with a mock binding.
function emailEnv(send = vi.fn().mockResolvedValue(undefined)) {
  return { env: { DB: env.DB, EMAIL: { send } }, send };
}

describe("staff admin API", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(NEW).run();
    await env.DB.prepare("DELETE FROM password_tokens").run();
    await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(NEW).run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("invite: creates row (no password), issues an invite token, and sends the email", async () => {
    const { env: e, send } = emailEnv();
    const res = await handleInviteStaff(
      new Request("https://example.com/api/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: NEW, role: "staff" }) }),
      e,
      ADMIN,
      "https://example.com"
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    const row = await env.DB.prepare("SELECT role, password_hash FROM staff_users WHERE email = ?").bind(NEW).first<{ role: string; password_hash: string | null }>();
    expect(row).toMatchObject({ role: "staff", password_hash: null });
    const tok = await env.DB.prepare("SELECT purpose FROM password_tokens WHERE email = ?").bind(NEW).first<{ purpose: string }>();
    expect(tok?.purpose).toBe("invite");
  });

  it("DELETE /api/staff/:email removes the user and their sessions", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(NEW).run();
    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent(NEW)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(NEW).first();
    expect(row).toBeNull();
  });

  it("DELETE /api/staff/:self is refused", async () => {
    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent("phill@tcbpestcontrolcanberra.com.au")}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("removing a staff member with an active session and a pending token succeeds and cleans up children (FK-safe)", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(NEW).run();
    await createSession(env.DB, NEW);
    await issueToken(env.DB, NEW, "invite");

    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent(NEW)}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(NEW).first()).toBeNull();
    const sess = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE email = ?").bind(NEW).first<{ n: number }>();
    expect(sess?.n).toBe(0);
    const toks = await env.DB.prepare("SELECT COUNT(*) AS n FROM password_tokens WHERE email = ?").bind(NEW).first<{ n: number }>();
    expect(toks?.n).toBe(0);
  });

  it("reset issues a reset token and sends the email", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(NEW).run();
    const { env: e, send } = emailEnv();
    const res = await handleSendReset(e, ADMIN, NEW, "https://example.com");
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    const tok = await env.DB.prepare("SELECT purpose FROM password_tokens WHERE email = ?").bind(NEW).first<{ purpose: string }>();
    expect(tok?.purpose).toBe("reset");
  });
});

describe("removing a staff member", () => {
  const GONE = "gone@example.com";
  const ADMIN = { email: "boss@example.com", role: "admin" as const };

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens WHERE staff_email = ?").bind(GONE).run();
    await env.DB.prepare("DELETE FROM user_settings WHERE email = ?").bind(GONE).run();
    await env.DB.prepare("DELETE FROM staff_users WHERE email IN (?, ?)").bind(GONE, ADMIN.email).run();
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(GONE).run();
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'admin', 1)").bind(ADMIN.email).run();
  });

  // getPushTokensForType selects every row in push_tokens and filters only on the owner having
  // switched that notification type off -- it never checks the owner still exists. Leaving the row
  // behind means a removed person's phone keeps showing inbound customer texts, sender name and
  // all, indefinitely, with nothing anywhere saying so.
  it("takes the departing member's handset off the notification list", async () => {
    await env.DB
      .prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)")
      .bind("ExponentPushToken[gone]", GONE)
      .run();
    await setUserSettings(env.DB, GONE, { ring_my_mobile: true, mobile_number: "0400000000" });

    expect((await handleRemoveStaff({ DB: env.DB } as never, ADMIN, GONE)).status).toBe(200);

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM push_tokens WHERE staff_email = ?").bind(GONE).first<{ n: number }>()
    ).toEqual({ n: 0 });
    // And their settings, so a re-invite does not silently restore the old mobile number onto
    // whoever next holds that address.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE email = ?").bind(GONE).first<{ n: number }>()
    ).toEqual({ n: 0 });
  });
});


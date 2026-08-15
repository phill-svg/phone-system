import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pool authenticates every SELF.fetch as phill (admin) via AUTH_MODE=dev.
const NEW = "invitee@example.com";

describe("staff admin API", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(NEW).run();
    await env.DB.prepare("DELETE FROM password_tokens").run();
    env.SENDGRID_API_KEY = "SG.test";
    env.AUTH_FROM_EMAIL = "no-reply@tcbpestcontrolcanberra.com.au";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POST /api/staff invites: creates row (no password) and issues an invite token", async () => {
    const res = await SELF.fetch("https://example.com/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NEW, role: "staff" }),
    });
    expect(res.status).toBe(200);
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

  it("POST /api/staff/:email/reset issues a reset token", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(NEW).run();
    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent(NEW)}/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const tok = await env.DB.prepare("SELECT purpose FROM password_tokens WHERE email = ?").bind(NEW).first<{ purpose: string }>();
    expect(tok?.purpose).toBe("reset");
  });
});

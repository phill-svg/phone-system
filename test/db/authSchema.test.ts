import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("0014 auth schema", () => {
  it("adds password columns to staff_users", async () => {
    const info = await env.DB.prepare("PRAGMA table_info(staff_users)").all<{ name: string }>();
    const cols = info.results.map((r) => r.name);
    expect(cols).toContain("password_hash");
    expect(cols).toContain("password_set_at");
  });

  it("creates sessions, password_tokens, login_attempts tables", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','password_tokens','login_attempts')"
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name).sort();
    expect(names).toEqual(["login_attempts", "password_tokens", "sessions"]);
  });

  it("inserts and reads a session row", async () => {
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).bind("hash-1", "phill@tcbpestcontrolcanberra.com.au", 1, 2).run();
    const row = await env.DB.prepare("SELECT email FROM sessions WHERE token_hash = ?").bind("hash-1").first<{ email: string }>();
    expect(row?.email).toBe("phill@tcbpestcontrolcanberra.com.au");
  });
});

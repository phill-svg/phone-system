import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { issueToken, peekToken, consumeToken } from "../../src/access/passwordTokens";

const EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("password tokens", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM password_tokens").run();
  });

  it("peek validates without consuming; consume works once", async () => {
    const token = await issueToken(env.DB, EMAIL, "invite");
    expect(await peekToken(env.DB, token)).toEqual({ email: EMAIL, purpose: "invite" });
    expect(await consumeToken(env.DB, token)).toEqual({ email: EMAIL, purpose: "invite" });
    expect(await consumeToken(env.DB, token)).toBeNull(); // already used
    expect(await peekToken(env.DB, token)).toBeNull();
  });

  it("returns null for unknown and expired tokens", async () => {
    expect(await consumeToken(env.DB, "nope")).toBeNull();
    const token = await issueToken(env.DB, EMAIL, "reset");
    await env.DB.prepare("UPDATE password_tokens SET expires_at = 1 WHERE email = ?").bind(EMAIL).run();
    expect(await peekToken(env.DB, token)).toBeNull();
    expect(await consumeToken(env.DB, token)).toBeNull();
  });
});

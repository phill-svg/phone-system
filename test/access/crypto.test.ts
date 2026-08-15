import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex, base64Encode, base64Decode } from "../../src/access/crypto";

describe("crypto utils", () => {
  it("randomToken returns url-safe unique tokens", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(42);
  });

  it("sha256Hex is stable and 64 hex chars", async () => {
    const h = await sha256Hex("hello");
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("base64 round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(base64Decode(base64Encode(bytes)))).toEqual([0, 1, 2, 250, 255]);
  });
});

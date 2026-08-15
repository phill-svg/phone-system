// test/access/breakglass-format.test.ts
// Verifies a hash produced by node:crypto (same algo/format as scripts/set-password.mjs)
// is accepted by the Worker's verifyPassword — guarding against a format drift that
// would make the break-glass path silently useless.
import { describe, expect, it } from "vitest";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { verifyPassword } from "../../src/access/password";

function nodeHash(password: string): string {
  const ITER = 210000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITER, 32, "sha256");
  return `pbkdf2$${ITER}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

describe("break-glass hash format", () => {
  it("node-generated hash verifies in the Worker", async () => {
    const stored = nodeHash("break-glass-pass-123");
    expect(await verifyPassword("break-glass-pass-123", stored)).toBe(true);
    expect(await verifyPassword("nope", stored)).toBe(false);
  });
});

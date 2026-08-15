import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, getDummyHash } from "../../src/access/password";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^pbkdf2\$210000\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a different salt/hash each time", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects a malformed stored value without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$abc$$")).toBe(false);
  });

  it("getDummyHash returns a valid, verifiable-format hash", async () => {
    const dummy = await getDummyHash();
    expect(dummy).toMatch(/^pbkdf2\$210000\$/);
    expect(await verifyPassword("anything", dummy)).toBe(false);
  });
});

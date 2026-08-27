import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFacebookName } from "../../src/facebook/graph";

// No real network calls: fetch is stubbed for every case here.
describe("resolveFacebookName", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the name field on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: "Jane Smith" }) })
    );
    expect(await resolveFacebookName("psid-1", "token")).toBe("Jane Smith");
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await resolveFacebookName("psid-1", "token")).toBeNull();
  });

  it("returns null if fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    expect(await resolveFacebookName("psid-1", "token")).toBeNull();
  });
});

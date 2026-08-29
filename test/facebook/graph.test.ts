import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupFacebookName, resolveFacebookName } from "../../src/facebook/graph";

// No real network calls: fetch is stubbed for every case here.
describe("lookupFacebookName", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the name on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: "Jane Smith" }) }));
    expect(await lookupFacebookName("psid-1", "token")).toEqual({ name: "Jane Smith" });
  });

  // The whole point of the error branch: an expired Page token is why names stop appearing, and
  // Facebook says so in the payload. Repeat it back rather than swallowing it.
  it("reports what Facebook objected to", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: "Error validating access token: Session has expired.", type: "OAuthException", code: 190 },
        }),
      })
    );
    const result = await lookupFacebookName("psid-1", "token");
    expect(result).toEqual({ error: "OAuthException 190: Error validating access token: Session has expired." });
  });

  it("falls back to the status code when the error body says nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    expect(await lookupFacebookName("psid-1", "token")).toEqual({ error: "Facebook returned HTTP 500." });
  });

  it("handles a 200 that carries no name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    expect(await lookupFacebookName("psid-1", "token")).toEqual({ error: "Facebook returned no name for this person." });
  });

  it("handles an unparseable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })
    );
    expect(await lookupFacebookName("psid-1", "token")).toEqual({ error: "Facebook returned no name for this person." });
  });

  it("reports a network failure instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await lookupFacebookName("psid-1", "token");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("network down");
  });
});

describe("resolveFacebookName", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the name when the lookup succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: "Jane Smith" }) }));
    expect(await resolveFacebookName("psid-1", "token")).toBe("Jane Smith");
  });

  it("returns null and logs the reason when it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await resolveFacebookName("psid-1", "token")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("psid-1"));
    warn.mockRestore();
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  it("has settings, calls, and call_events tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(["settings", "calls", "call_events"]));
  });
});

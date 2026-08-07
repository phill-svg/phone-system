import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker health check", () => {
  it("responds 200 ok on GET /health", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

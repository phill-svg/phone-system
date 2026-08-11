import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePutBusinessHours, handlePutCallBlocklist } from "../../src/api/settings";
import { getCallBlocklist } from "../../src/db/settings";

const STAFF: import("../../src/access/requireStaffUser").StaffUser = {
  email: "tech@example.com",
  role: "staff",
};

describe("settings admin gating", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("handlePutBusinessHours returns 403 for a non-admin staff user", async () => {
    const request = new Request("https://example.com/api/settings/business-hours", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const response = await handlePutBusinessHours(request, env.DB, STAFF);
    expect(response.status).toBe(403);
  });
});

describe("handlePutCallBlocklist", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("rejects non-admins", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000"]) }),
      env.DB,
      { email: "staff@b.com", role: "staff" }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a non-array body", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ not: "an array" }) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(400);
  });

  it("rejects an array containing a non-string", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000", 5]) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(400);
  });

  it("saves a valid list for an admin", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000"]) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(200);
    expect(await getCallBlocklist(env.DB)).toEqual(["+61400000000"]);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePutBusinessHours, handlePutStaffRingList } from "../../src/api/settings";

const STAFF: import("../../src/access/requireStaffUser").StaffUser = {
  email: "tech@example.com",
  role: "staff",
  mobile_number: null,
};
const ADMIN: import("../../src/access/requireStaffUser").StaffUser = {
  email: "admin@example.com",
  role: "admin",
  mobile_number: null,
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

  it("handlePutStaffRingList returns 403 for a non-admin staff user", async () => {
    const request = new Request("https://example.com/api/settings/staff-ring-list", {
      method: "PUT",
      body: JSON.stringify([]),
    });
    const response = await handlePutStaffRingList(request, env.DB, STAFF);
    expect(response.status).toBe(403);
  });

  it("handlePutStaffRingList accepts entries with isOnCall true, false, or omitted", async () => {
    const request = new Request("https://example.com/api/settings/staff-ring-list", {
      method: "PUT",
      body: JSON.stringify([
        { label: "Phill (mobile)", number: "+61400000000", isOnCall: true },
        { label: "Backup", number: "+61400000001", isOnCall: false },
        { label: "No isOnCall field", number: "+61400000002" },
      ]),
    });
    const response = await handlePutStaffRingList(request, env.DB, ADMIN);
    expect(response.status).toBe(200);
  });

  it("handlePutStaffRingList returns 400 when isOnCall is not a boolean", async () => {
    const request = new Request("https://example.com/api/settings/staff-ring-list", {
      method: "PUT",
      body: JSON.stringify([{ label: "Phill (mobile)", number: "+61400000000", isOnCall: "yes" }]),
    });
    const response = await handlePutStaffRingList(request, env.DB, ADMIN);
    expect(response.status).toBe(400);
  });
});

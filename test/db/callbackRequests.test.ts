import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCallbackRequest, listOpenCallbackRequests } from "../../src/db/callbackRequests";

async function seedCall(id: string) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61200000000", Date.now())
    .run();
}

describe("db/callbackRequests", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM callback_requests").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("createCallbackRequest inserts an open row with a real timestamp", async () => {
    await seedCall("CA-cb-1");
    const before = Date.now();

    await createCallbackRequest(env.DB, { callId: "CA-cb-1", callerNumber: "+61400000000" });

    const row = await env.DB.prepare("SELECT * FROM callback_requests WHERE call_id = ?")
      .bind("CA-cb-1")
      .first<{ call_id: string; caller_number: string; requested_at: number; status: string }>();

    expect(row?.call_id).toBe("CA-cb-1");
    expect(row?.caller_number).toBe("+61400000000");
    expect(row?.status).toBe("open");
    expect(row?.requested_at).toBeGreaterThanOrEqual(before);
    expect(row?.requested_at).toBeLessThanOrEqual(Date.now());
  });

  it("listOpenCallbackRequests returns only open rows, newest first", async () => {
    await seedCall("CA-cb-open-old");
    await seedCall("CA-cb-open-new");
    await seedCall("CA-cb-done");

    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
      .bind("CA-cb-open-old", "+61400000001", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
      .bind("CA-cb-open-new", "+61400000002", 2000)
      .run();
    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
      .bind("CA-cb-done", "+61400000003", 1500)
      .run();
    await env.DB.prepare("UPDATE callback_requests SET status = 'done' WHERE call_id = ?")
      .bind("CA-cb-done")
      .run();

    const result = await listOpenCallbackRequests(env.DB);
    expect(result.map((r) => r.call_id)).toEqual(["CA-cb-open-new", "CA-cb-open-old"]);
    expect(result.every((r) => r.status === "open")).toBe(true);
  });
});

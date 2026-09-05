import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListCallbackRequests, handleUpdateCallbackRequest } from "../../src/api/callbackRequests";
import type { StaffUser } from "../../src/access/requireStaffUser";

const STAFF = { email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" } as StaffUser;

async function seedCall(id: string) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61200000000", Date.now())
    .run();
}

async function seedRequest(callId: string, requestedAt: number, status: "open" | "done" = "open") {
  await seedCall(callId);
  await env.DB.prepare(
    "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, ?)"
  )
    .bind(callId, "+61400000001", requestedAt, status)
    .run();
  const row = await env.DB.prepare("SELECT id FROM callback_requests WHERE call_id = ?")
    .bind(callId)
    .first<{ id: number }>();
  return row!.id;
}

function putRequest(body: unknown): Request {
  return new Request("https://example.com/api/callback-requests/1", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("handleListCallbackRequests", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM callback_requests").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("returns open requests followed by handled ones, so the app can show history", async () => {
    await seedRequest("CA-wrap-open", 1000, "open");
    await seedRequest("CA-wrap-done", 2000, "done");

    const response = await handleListCallbackRequests(env.DB);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { call_id: string; status: string }[];
    expect(body.map((r) => r.call_id)).toEqual(["CA-wrap-open", "CA-wrap-done"]);
  });

  it("returns an empty array when there are no callback requests at all", async () => {
    const response = await handleListCallbackRequests(env.DB);
    expect(await response.json()).toEqual([]);
  });
});

describe("handleUpdateCallbackRequest", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM callback_requests").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("marks a request done and records the staff member who did it", async () => {
    const id = await seedRequest("CA-put-done", 1000);

    const response = await handleUpdateCallbackRequest(putRequest({ status: "done" }), env.DB, id, STAFF);
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM callback_requests WHERE id = ?")
      .bind(id)
      .first<{ status: string; done_by: string | null; done_at: number | null }>();
    expect(row?.status).toBe("done");
    expect(row?.done_by).toBe(STAFF.email);
    expect(row?.done_at).not.toBeNull();
  });

  it("reopens a request, clearing the handled-by stamp", async () => {
    const id = await seedRequest("CA-put-reopen", 1000);
    await handleUpdateCallbackRequest(putRequest({ status: "done" }), env.DB, id, STAFF);

    const response = await handleUpdateCallbackRequest(putRequest({ status: "open" }), env.DB, id, STAFF);
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM callback_requests WHERE id = ?")
      .bind(id)
      .first<{ status: string; done_by: string | null; done_at: number | null }>();
    expect(row?.status).toBe("open");
    expect(row?.done_by).toBeNull();
    expect(row?.done_at).toBeNull();
  });

  it("rejects a status that is not open or done", async () => {
    const id = await seedRequest("CA-put-bad", 1000);
    const response = await handleUpdateCallbackRequest(putRequest({ status: "maybe" }), env.DB, id, STAFF);
    expect(response.status).toBe(400);

    const row = await env.DB.prepare("SELECT status FROM callback_requests WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("open");
  });

  it("rejects a body that is not JSON", async () => {
    const id = await seedRequest("CA-put-nonjson", 1000);
    const bad = new Request("https://example.com/api/callback-requests/1", { method: "PUT", body: "nope" });
    expect((await handleUpdateCallbackRequest(bad, env.DB, id, STAFF)).status).toBe(400);
  });

  it("404s an id that does not exist", async () => {
    const response = await handleUpdateCallbackRequest(putRequest({ status: "done" }), env.DB, 999999, STAFF);
    expect(response.status).toBe(404);
  });
});

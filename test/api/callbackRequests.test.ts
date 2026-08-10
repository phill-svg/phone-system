import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleListCallbackRequests } from "../../src/api/callbackRequests";

async function seedCall(id: string) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61200000000", Date.now())
    .run();
}

describe("handleListCallbackRequests", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM callback_requests").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("returns only open callback requests as JSON", async () => {
    await seedCall("CA-wrap-open");
    await seedCall("CA-wrap-done");
    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'open')"
    )
      .bind("CA-wrap-open", "+61400000001", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, 'done')"
    )
      .bind("CA-wrap-done", "+61400000002", 2000)
      .run();

    const response = await handleListCallbackRequests(env.DB);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { call_id: string; status: string }[];
    expect(body.map((r) => r.call_id)).toEqual(["CA-wrap-open"]);
    expect(body.every((r) => r.status === "open")).toBe(true);
  });

  it("returns an empty array when there are no open callback requests", async () => {
    const response = await handleListCallbackRequests(env.DB);
    expect(await response.json()).toEqual([]);
  });
});

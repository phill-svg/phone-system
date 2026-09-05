import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCallbackRequest,
  listCallbackRequests,
  listOpenCallbackRequests,
  setCallbackRequestStatus,
} from "../../src/db/callbackRequests";

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

  it("setCallbackRequestStatus stamps who handled it and when, and clears both on reopen", async () => {
    await seedCall("CA-cb-stamp");
    await createCallbackRequest(env.DB, { callId: "CA-cb-stamp", callerNumber: "+61400000004" });
    const { id } = (await env.DB.prepare("SELECT id FROM callback_requests WHERE call_id = ?")
      .bind("CA-cb-stamp")
      .first<{ id: number }>())!;
    const before = Date.now();

    expect(await setCallbackRequestStatus(env.DB, id, "done", "phill@tcbpestcontrolcanberra.com.au")).toBe(true);

    const done = await env.DB.prepare("SELECT * FROM callback_requests WHERE id = ?")
      .bind(id)
      .first<{ status: string; done_at: number | null; done_by: string | null }>();
    expect(done?.status).toBe("done");
    expect(done?.done_by).toBe("phill@tcbpestcontrolcanberra.com.au");
    expect(done?.done_at).toBeGreaterThanOrEqual(before);

    // Reopening must not leave a stale "handled by" behind -- the pair always matches status.
    expect(await setCallbackRequestStatus(env.DB, id, "open", "someone@else.com")).toBe(true);
    const reopened = await env.DB.prepare("SELECT * FROM callback_requests WHERE id = ?")
      .bind(id)
      .first<{ status: string; done_at: number | null; done_by: string | null }>();
    expect(reopened?.status).toBe("open");
    expect(reopened?.done_at).toBeNull();
    expect(reopened?.done_by).toBeNull();
  });

  it("setCallbackRequestStatus reports false for an id that does not exist", async () => {
    expect(await setCallbackRequestStatus(env.DB, 999999, "done", "phill@tcbpestcontrolcanberra.com.au")).toBe(false);
  });

  it("listCallbackRequests returns every open row plus a bounded tail of done ones", async () => {
    const rows: [string, "open" | "done", number][] = [
      ["open-a", "open", 1000],
      ["open-b", "open", 3000],
      ["open-c", "open", 2000],
      ["done-old", "done", 100],
      ["done-mid", "done", 200],
      ["done-new", "done", 300],
    ];
    for (const [name, status, requestedAt] of rows) {
      await seedCall(`CA-${name}`);
      await env.DB.prepare(
        "INSERT INTO callback_requests (call_id, caller_number, requested_at, status) VALUES (?, ?, ?, ?)"
      )
        .bind(`CA-${name}`, "+61400000005", requestedAt, status)
        .run();
    }

    // Ask for a done tail of two, with three done rows present.
    const result = await listCallbackRequests(env.DB, 2);

    // Every open row survives the cap -- they are the work queue, newest request first.
    expect(result.filter((r) => r.status === "open").map((r) => r.call_id)).toEqual([
      "CA-open-b",
      "CA-open-c",
      "CA-open-a",
    ]);
    // Only the newest two done rows come back.
    expect(result.filter((r) => r.status === "done").map((r) => r.call_id)).toEqual([
      "CA-done-new",
      "CA-done-mid",
    ]);
  });
});

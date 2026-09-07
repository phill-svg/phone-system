import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDeleteCall, handleRestoreCall, handleDeleteThread, handleRestoreThread } from "../../src/api/deletions";
import { listCalls, getCallDetail, getCallStats } from "../../src/db/calls";
import { listConversations, listThread } from "../../src/db/messages";

const ADMIN = { email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" as const };
const STAFF = { email: "mate@example.com", role: "staff" as const };
const PEER = "+61402430107";

async function seedCall(id: string, startedAt = Date.now()): Promise<void> {
  await env.DB
    .prepare("INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours, status, direction, ended_at) VALUES (?, ?, '+61261059771', ?, 0, 'completed', 'inbound', ?)")
    .bind(id, PEER, startedAt, startedAt + 30_000)
    .run();
}

async function seedMessage(id: string, createdAt: number): Promise<void> {
  await env.DB
    .prepare("INSERT INTO messages (id, direction, peer_number, body, status, read, created_at) VALUES (?, 'inbound', ?, 'hello', 'received', 0, ?)")
    .bind(id, PEER, createdAt)
    .run();
}

const restoreReq = (deletedAt: number) =>
  new Request("https://example.com/x", { method: "POST", body: JSON.stringify({ deletedAt }) });

describe("deleting a call log", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is refused for a non-admin — these are business-wide records", async () => {
    await seedCall("CA-del");
    const res = await handleDeleteCall(env.DB, "CA-del", STAFF);
    expect(res.status).toBe(403);
    expect(await listCalls(env.DB)).toHaveLength(1);
  });

  it("hides the call from history, detail and the analytics stats", async () => {
    await seedCall("CA-del");
    expect(await listCalls(env.DB)).toHaveLength(1);

    const res = await handleDeleteCall(env.DB, "CA-del", ADMIN);
    expect(res.status).toBe(200);

    expect(await listCalls(env.DB)).toHaveLength(0);
    expect(await getCallDetail(env.DB, "CA-del")).toBeNull();
    // A deleted call must not keep skewing answer rates on the analytics page either.
    expect((await getCallStats(env.DB, 0)).total).toBe(0);
  });

  // The whole point of hiding rather than deleting.
  it("comes back on restore, with the row and its recording never having gone anywhere", async () => {
    await seedCall("CA-del");
    await handleDeleteCall(env.DB, "CA-del", ADMIN);
    const res = await handleRestoreCall(env.DB, "CA-del", ADMIN);
    expect(res.status).toBe(200);
    expect(await listCalls(env.DB)).toHaveLength(1);
  });

  it("records who deleted it", async () => {
    await seedCall("CA-del");
    await handleDeleteCall(env.DB, "CA-del", ADMIN);
    const row = await env.DB.prepare("SELECT deleted_by FROM calls WHERE id = 'CA-del'").first<{ deleted_by: string }>();
    expect(row?.deleted_by).toBe(ADMIN.email);
  });

  it("404s a second delete rather than offering an undo that would do nothing", async () => {
    await seedCall("CA-del");
    await handleDeleteCall(env.DB, "CA-del", ADMIN);
    expect((await handleDeleteCall(env.DB, "CA-del", ADMIN)).status).toBe(404);
    expect((await handleDeleteCall(env.DB, "CA-never-existed", ADMIN)).status).toBe(404);
  });

  it("restoring something that isn't deleted is a 404, not a silent success", async () => {
    await seedCall("CA-del");
    expect((await handleRestoreCall(env.DB, "CA-del", ADMIN)).status).toBe(404);
  });
});

describe("deleting a conversation", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM messages").run();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is refused for a non-admin", async () => {
    await seedMessage("SM1", 1000);
    expect((await handleDeleteThread(env.DB, PEER, STAFF)).status).toBe(403);
    expect(await listConversations(env.DB)).toHaveLength(1);
  });

  it("hides every message in it, from both the list and the thread", async () => {
    await seedMessage("SM1", 1000);
    await seedMessage("SM2", 2000);
    expect(await listConversations(env.DB)).toHaveLength(1);

    const res = await handleDeleteThread(env.DB, PEER, ADMIN);
    expect(res.status).toBe(200);
    expect((await res.json<{ messages: number }>()).messages).toBe(2);

    expect(await listConversations(env.DB)).toHaveLength(0);
    expect(await listThread(env.DB, PEER)).toHaveLength(0);
  });

  // A second delete of the same number must not resurrect the first one's messages on undo.
  it("undo restores only the messages that delete hid", async () => {
    await seedMessage("OLD", 1000);
    const first = await handleDeleteThread(env.DB, PEER, ADMIN);
    const firstStamp = (await first.json<{ deletedAt: number }>()).deletedAt;

    await seedMessage("NEW", 2000);
    const second = await handleDeleteThread(env.DB, PEER, ADMIN);
    const secondStamp = (await second.json<{ deletedAt: number }>()).deletedAt;
    expect(secondStamp).not.toBe(firstStamp);

    const res = await handleRestoreThread(restoreReq(secondStamp), env.DB, PEER, ADMIN);
    expect(res.status).toBe(200);

    const thread = await listThread(env.DB, PEER);
    expect(thread.map((m) => m.id)).toEqual(["NEW"]);
  });

  it("refuses an undo with no stamp rather than guessing which delete to reverse", async () => {
    await seedMessage("SM1", 1000);
    await handleDeleteThread(env.DB, PEER, ADMIN);
    const res = await handleRestoreThread(new Request("https://example.com/x", { method: "POST", body: "{}" }), env.DB, PEER, ADMIN);
    expect(res.status).toBe(400);
  });

  it("404s deleting a conversation that has no messages", async () => {
    expect((await handleDeleteThread(env.DB, "+61400000000", ADMIN)).status).toBe(404);
  });
});

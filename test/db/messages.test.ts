import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMessage, listConversations, updateMessageStatus } from "../../src/db/messages";
import { upsertFacebookName } from "../../src/db/fbContacts";

describe("listConversations", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM messages").run();
    await env.DB.prepare("DELETE FROM fb_contacts").run();
  });

  it("resolves a messenger peer's name from the fb_contacts cache", async () => {
    await upsertFacebookName(env.DB, "psid-123", "Jane Smith");
    await insertMessage(env.DB, {
      id: "m1",
      direction: "inbound",
      peer_number: "messenger:psid-123",
      our_number: null,
      body: "hi there",
      status: "received",
      read: 0,
      createdAt: Date.now(),
    });

    const conversations = await listConversations(env.DB);
    const convo = conversations.find((c) => c.number === "messenger:psid-123");
    expect(convo?.name).toBe("Jane Smith");
  });

  it("leaves name null for a plain SMS peer (resolved client-side by phone number)", async () => {
    await insertMessage(env.DB, {
      id: "m2",
      direction: "inbound",
      peer_number: "+61400123456",
      our_number: null,
      body: "hey",
      status: "received",
      read: 0,
      createdAt: Date.now(),
    });

    const conversations = await listConversations(env.DB);
    const convo = conversations.find((c) => c.number === "+61400123456");
    expect(convo?.name).toBeNull();
  });

  it("leaves name null for a messenger peer with no cached fb_contacts row", async () => {
    await insertMessage(env.DB, {
      id: "m3",
      direction: "inbound",
      peer_number: "messenger:psid-unresolved",
      our_number: null,
      body: "yo",
      status: "received",
      read: 0,
      createdAt: Date.now(),
    });

    const conversations = await listConversations(env.DB);
    const convo = conversations.find((c) => c.number === "messenger:psid-unresolved");
    expect(convo?.name).toBeNull();
  });
});

describe("updateMessageStatus", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM messages").run();
    await insertMessage(env.DB, {
      id: "sid-1",
      direction: "outbound",
      peer_number: "messenger:psid-1",
      our_number: "messenger:page-1",
      body: "hello",
      status: "sent",
      read: 1,
      createdAt: Date.now(),
    });
  });

  const read = () =>
    env.DB.prepare("SELECT status, error_code, error_message FROM messages WHERE id = 'sid-1'")
      .first<{ status: string; error_code: string | null; error_message: string | null }>();

  it("records a failure and its reason", async () => {
    await updateMessageStatus(env.DB, "sid-1", "failed", { code: "63001", message: "Channel auth failed" });
    const row = await read();
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("63001");
  });

  // Twilio's status callbacks are NOT ordered. A `sent` that lands after the `failed` it preceded
  // used to overwrite the terminal status AND null the ErrorCode with it -- so the message read as
  // fine in the app, and it dropped out of checkMessengerChannelHealth's count, quietening the
  // outage alarm exactly when the outage was worst.
  it("does not let a late non-terminal callback erase a recorded failure", async () => {
    await updateMessageStatus(env.DB, "sid-1", "failed", { code: "63001", message: "Channel auth failed" });
    await updateMessageStatus(env.DB, "sid-1", "sent");
    const row = await read();
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("63001");
    expect(row?.error_message).toBe("Channel auth failed");
  });

  // The same rule the recording columns got in tier 2: a later callback may ADD what it knows,
  // never blank what an earlier one already recorded.
  it("keeps the error fields when a later terminal callback carries none", async () => {
    await updateMessageStatus(env.DB, "sid-1", "undelivered", { code: "30008", message: "Unknown error" });
    await updateMessageStatus(env.DB, "sid-1", "delivered");
    const row = await read();
    expect(row?.status).toBe("delivered");
    expect(row?.error_code).toBe("30008");
  });

  it("still applies ordinary forward progress", async () => {
    await updateMessageStatus(env.DB, "sid-1", "delivered");
    expect((await read())?.status).toBe("delivered");
  });
});

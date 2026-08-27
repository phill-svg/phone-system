import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMessage, listConversations } from "../../src/db/messages";
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

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getFacebookName, listUnnamedFacebookPsids, upsertFacebookName } from "../../src/db/fbContacts";
import { insertMessage } from "../../src/db/messages";

describe("fbContacts db", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM fb_contacts").run();
  });

  it("returns null when no cached name exists for the psid", async () => {
    expect(await getFacebookName(env.DB, "psid-unknown")).toBeNull();
  });

  it("upserts a name then returns it", async () => {
    await upsertFacebookName(env.DB, "psid-1", "Jane Smith");
    expect(await getFacebookName(env.DB, "psid-1")).toBe("Jane Smith");
  });

  it("upserting twice for the same psid updates the name rather than erroring", async () => {
    await upsertFacebookName(env.DB, "psid-1", "Jane Smith");
    await upsertFacebookName(env.DB, "psid-1", "Jane A. Smith");
    expect(await getFacebookName(env.DB, "psid-1")).toBe("Jane A. Smith");

    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM fb_contacts WHERE psid = ?")
      .bind("psid-1")
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});

describe("listUnnamedFacebookPsids", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM fb_contacts").run();
    await env.DB.prepare("DELETE FROM messages").run();
  });

  async function message(peer: string): Promise<void> {
    await insertMessage(env.DB, {
      id: `m-${peer}-${Math.random()}`,
      direction: "inbound",
      peer_number: peer,
      our_number: null,
      body: "hi",
      status: "received",
      read: 0,
      createdAt: Date.now(),
    });
  }

  it("lists Messenger senders with no cached name, once each, and ignores phone numbers", async () => {
    await message("messenger:111");
    await message("messenger:111");
    await message("messenger:222");
    await message("+61400000000");
    expect(await listUnnamedFacebookPsids(env.DB)).toEqual(["111", "222"]);
  });

  it("drops a sender once its name is cached", async () => {
    await message("messenger:111");
    await message("messenger:222");
    await upsertFacebookName(env.DB, "111", "Jane Smith");
    expect(await listUnnamedFacebookPsids(env.DB)).toEqual(["222"]);
  });

  it("returns nothing when there are no Messenger conversations", async () => {
    await message("+61400000000");
    expect(await listUnnamedFacebookPsids(env.DB)).toEqual([]);
  });
});

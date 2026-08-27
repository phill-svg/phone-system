import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getFacebookName, upsertFacebookName } from "../../src/db/fbContacts";

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

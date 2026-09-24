import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createContact,
  findContactByPhone,
  importContacts,
  listContacts,
  normalizePhone,
  updateContact,
  deleteContact,
} from "../../src/db/contacts";

describe("normalizePhone", () => {
  it("normalizes AU formats to a common digits-only key so calls match contacts", () => {
    // The three ways the same AU mobile shows up (E.164 from Twilio, national 0-prefixed,
    // spaced) must all collapse to one key.
    expect(normalizePhone("+61 400 123 456")).toBe("61400123456");
    expect(normalizePhone("0400 123 456")).toBe("61400123456");
    expect(normalizePhone("0400123456")).toBe("61400123456");
    expect(normalizePhone("(02) 8395 3312")).toBe("61283953312");
    expect(normalizePhone("+61283953312")).toBe("61283953312");
    expect(normalizePhone("")).toBe("");
  });
});

describe("contacts db", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM contacts").run();
  });

  it("stores a normalized number on create for call matching", async () => {
    const c = await createContact(env.DB, { name: "Jane Smith", phone: "0400 123 456", company: "Capital Signs" });
    expect(c.phone).toBe("0400 123 456");
    expect(c.phone_normalized).toBe("61400123456");
    expect(c.company).toBe("Capital Signs");
  });

  it("upserts by phone number on import: same number updates rather than duplicating", async () => {
    const first = await importContacts(env.DB, [
      { name: "Jane Smith", phone: "0400 123 456", company: "Capital Signs" },
      { name: "Wei Dong", phone: "+61 411 987 654" },
    ]);
    expect(first).toEqual({ imported: 2, updated: 0, skipped: 0 });

    // Re-import the same mobile in E.164 form with an updated name -> updates, no duplicate.
    const second = await importContacts(env.DB, [
      { name: "Jane A. Smith", phone: "+61400123456", company: "Capital Signs Pty Ltd" },
      { name: "", phone: "0000" }, // missing name -> skipped
    ]);
    expect(second.updated).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);

    const all = await listContacts(env.DB);
    expect(all.length).toBe(2);
    const jane = all.find((c) => c.phone_normalized === "61400123456");
    expect(jane?.name).toBe("Jane A. Smith");
    expect(jane?.company).toBe("Capital Signs Pty Ltd");
  });

  it("updates and deletes a contact", async () => {
    const c = await createContact(env.DB, { name: "Temp", phone: "0400000000" });
    const ok = await updateContact(env.DB, c.id, { name: "Renamed", phone: "0411111111", company: null });
    expect(ok).toBe(true);
    let all = await listContacts(env.DB);
    expect(all[0].name).toBe("Renamed");
    expect(all[0].phone_normalized).toBe("61411111111");

    await deleteContact(env.DB, c.id);
    all = await listContacts(env.DB);
    expect(all.length).toBe(0);
  });
});

// A number saved as two contacts is named the same on every surface: the first by name, which is
// what the web pages pick from listContacts.
describe("findContactByPhone with a number saved twice", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM contacts").run();
  });

  it("returns the first contact by name, not the first saved", async () => {
    await createContact(env.DB, { name: "Zed Plumbing", phone: "0400 111 222" });
    await createContact(env.DB, { name: "alice smith", phone: "+61 400 111 222" });
    expect((await findContactByPhone(env.DB, "+61400111222"))?.name).toBe("alice smith");
  });
});

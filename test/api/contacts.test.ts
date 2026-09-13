import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateContact, handleUpdateContact } from "../../src/api/contacts";
import { createContact } from "../../src/db/contacts";

const req = (body: unknown) => new Request("https://x/api/contacts", { method: "POST", body: JSON.stringify(body) });

// A phone with no digits normalises to "", and the handset's caller-name lookup matched "" against
// every caller not in the book -- every stranger rang in under that contact's name. Import already
// refused these; create and update did not.
describe("contacts API refuses a phone with no digits", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM contacts").run();
  });

  it("on create", async () => {
    const res = await handleCreateContact(req({ name: "Jo", phone: "TBC" }), env.DB);
    expect(res.status).toBe(400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  // The happy paths, so a broken success branch cannot hide behind the 400s above.
  it("still creates and updates a contact with a real number", async () => {
    const created = await handleCreateContact(req({ name: "Jo", phone: "0412 345 678" }), env.DB);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    const updated = await handleUpdateContact(req({ name: "Jo B", phone: "0412 345 679" }), env.DB, id);
    expect(updated.status).toBe(200);
  });

  it("on update", async () => {
    const c = await createContact(env.DB, { name: "Jo", phone: "0412 345 678", company: null });
    const res = await handleUpdateContact(req({ name: "Jo", phone: "n/a" }), env.DB, c.id);
    expect(res.status).toBe(400);
    const row = await env.DB.prepare("SELECT phone_normalized FROM contacts WHERE id = ?").bind(c.id).first<{ phone_normalized: string }>();
    expect(row?.phone_normalized).not.toBe("");
  });
});

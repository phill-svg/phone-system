import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTACT_LOOKUP_BATCH,
  handleServiceM8ContactLookup,
  handleServiceM8ContactSave,
  listUnsavedNumbers,
} from "../../src/api/servicem8ContactSync";
import { createContact } from "../../src/db/contacts";

// Admin > Sync contacts: every number that has called or texted and has no saved contact is looked
// up in ServiceM8, the matches are shown to an admin, and only the ticked ones are saved.

const DEV = "phill@tcbpestcontrolcanberra.com.au";
const BUSINESS = { TWILIO_FROM_NUMBER: "+61866108941", TWILIO_SMS_NUMBER: "+61485034869" };

async function seedCall(id: string, direction: "inbound" | "outbound", caller: string, called: string, startedAt: number, deletedAt: number | null = null) {
  await env.DB
    .prepare("INSERT INTO calls (id, caller_number, called_number, started_at, direction, deleted_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, caller, called, startedAt, direction, deletedAt)
    .run();
}

async function seedMessage(id: string, peer: string, createdAt: number, deletedAt: number | null = null) {
  await env.DB
    .prepare("INSERT INTO messages (id, direction, peer_number, body, status, read, created_at, deleted_at) VALUES (?, 'inbound', ?, 'hi', 'received', 1, ?, ?)")
    .bind(id, peer, createdAt, deletedAt)
    .run();
}

async function clearTables() {
  await env.DB.prepare("DELETE FROM user_settings").run();
  await env.DB.prepare("DELETE FROM calls").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM contacts").run();
  await env.DB.prepare("DELETE FROM phone_numbers").run();
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const company = (name: string) => ({ results: [{ type: "company", uuid: "c1", title: "Company [c1]", data: { name } }] });

// Answers a ServiceM8 search per number from `names` (local 04... form, as the client sends it);
// a number not in the map comes back with no results. Records every URL fetched.
function stubServiceM8(names: Record<string, string>, opts: { searchStatus?: number; jobcontact?: unknown[] } = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/search.json")) {
        if (opts.searchStatus) return json({ error: "nope" }, opts.searchStatus);
        const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
        return json(names[q] ? company(names[q]) : { results: [] });
      }
      if (url.includes("/jobcontact.json")) return json(opts.jobcontact ?? []);
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
  return urls;
}

const lookupEnv = (key: string | null = "sm8-key") => ({ DB: env.DB, SERVICEM8_API_KEY: key ?? undefined, ...BUSINESS });
const post = (body: unknown) =>
  new Request("https://x/api/admin/servicem8/contact-lookup", { method: "POST", body: JSON.stringify(body) });

describe("listUnsavedNumbers", () => {
  beforeEach(clearTables);

  it("lists each customer number with no saved contact once, with when it was last seen", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    await seedCall("CA2", "inbound", "+61400000001", "+61261059771", 3000);
    // Outbound rows carry the BUSINESS number in caller_number; the customer is called_number.
    await seedCall("CA3", "outbound", "+61261059771", "+61400000002", 2000);
    await seedMessage("SM1", "+61400000003", 4000);
    await seedMessage("SM2", "+61400000001", 5000);

    expect(await listUnsavedNumbers(env.DB, BUSINESS)).toEqual([
      { phone: "+61400000001", lastSeen: 5000 },
      { phone: "+61400000002", lastSeen: 2000 },
      { phone: "+61400000003", lastSeen: 4000 },
    ]);
  });

  it("leaves out saved contacts however they were typed, the business's own numbers, Messenger, withheld and deleted rows", async () => {
    await createContact(env.DB, { name: "Sue", phone: "0400 000 001", company: null });
    await env.DB
      .prepare("INSERT INTO phone_numbers (e164, label, created_at) VALUES ('+61261059771', 'Landline', 1)")
      .run();
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    await seedCall("CA2", "outbound", "+61866108941", "+61261059771", 1000);
    await seedCall("CA3", "inbound", "+61485034869", "+61261059771", 1000);
    await seedCall("CA4", "inbound", "anonymous", "+61261059771", 1000);
    await seedCall("CA5", "inbound", "+61400000005", "+61261059771", 1000, 99);
    await seedMessage("SM1", "messenger:12345", 1000);
    await seedMessage("SM2", "+61400000006", 1000, 99);
    await seedCall("CA6", "inbound", "+61400000007", "+61261059771", 1000);

    expect(await listUnsavedNumbers(env.DB, BUSINESS)).toEqual([{ phone: "+61400000007", lastSeen: 1000 }]);
  });

  // A staff member's test call to the landline puts their own mobile in `calls`. Saving it under a
  // customer's name would label every call and text from that staff member as the customer.
  it("leaves out a staff member's own mobile, however it was typed", async () => {
    await env.DB
      .prepare("INSERT INTO user_settings (email, key, value, updated_at) VALUES (?, 'mobile_number', ?, 1)")
      .bind(DEV, JSON.stringify("0400 000 009"))
      .run();
    await seedCall("CA1", "inbound", "+61400000009", "+61261059771", 1000);
    await seedCall("CA2", "inbound", "+61400000010", "+61261059771", 1000);
    expect(await listUnsavedNumbers(env.DB, BUSINESS)).toEqual([{ phone: "+61400000010", lastSeen: 1000 }]);
  });
});

describe("handleServiceM8ContactLookup", () => {
  beforeEach(clearTables);
  afterEach(() => vi.unstubAllGlobals());

  it("returns the numbers ServiceM8 knows, by name, and skips the ones it does not", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    await seedCall("CA2", "inbound", "+61400000002", "+61261059771", 2000);
    stubServiceM8({ "0400000001": "Sue Dunkley" });

    const res = await handleServiceM8ContactLookup(post({}), lookupEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      matches: [{ phone: "+61400000001", name: "Sue Dunkley", lastSeen: 1000 }],
      checked: 2,
      failed: 0,
      total: 2,
      remaining: 0,
      next: null,
    });
  });

  it("checks a fixed batch per request and hands back a cursor for the rest", async () => {
    const count = CONTACT_LOOKUP_BATCH + 3;
    for (let i = 0; i < count; i++) {
      await seedCall(`CA${i}`, "inbound", `+614000001${String(i).padStart(2, "0")}`, "+61261059771", 1000 + i);
    }
    const urls = stubServiceM8({});

    const first = await (await handleServiceM8ContactLookup(post({}), lookupEnv())).json<{ checked: number; remaining: number; next: string | null; total: number }>();
    expect(first.checked).toBe(CONTACT_LOOKUP_BATCH);
    expect(first.total).toBe(count);
    expect(first.remaining).toBe(3);
    expect(first.next).toBe(`+614000001${String(CONTACT_LOOKUP_BATCH - 1).padStart(2, "0")}`);
    expect(urls).toHaveLength(CONTACT_LOOKUP_BATCH);

    const second = await (await handleServiceM8ContactLookup(post({ after: first.next }), lookupEnv())).json<{ checked: number; remaining: number; next: string | null }>();
    expect(second.checked).toBe(3);
    expect(second.remaining).toBe(0);
    expect(second.next).toBeNull();
  });

  it("names the customer from the job contact when the search results carry no name", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/search.json")) return json({ results: [{ type: "job", uuid: "j1", title: "Warehouse" }] });
        if (url.includes("/jobcontact.json")) return json([{ first: "Jo", last: "Bloggs" }]);
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const body = await (await handleServiceM8ContactLookup(post({}), lookupEnv())).json<{ matches: unknown[] }>();
    expect(body.matches).toEqual([{ phone: "+61400000001", name: "Jo Bloggs", lastSeen: 1000 }]);
  });

  it("says ServiceM8 is not connected, without calling it, when there is no API key", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    const urls = stubServiceM8({});
    const res = await handleServiceM8ContactLookup(post({}), lookupEnv(null));
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toMatch(/ServiceM8/);
    expect(urls).toHaveLength(0);
  });

  // A revoked key fails every search identically. Reporting "found nobody" would be a lie.
  it("reports a refusal when every search in the batch failed", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    stubServiceM8({}, { searchStatus: 401 });
    const res = await handleServiceM8ContactLookup(post({}), lookupEnv());
    expect(res.status).toBe(502);
    const { error } = await res.json<{ error: string }>();
    expect(error).toMatch(/ServiceM8/);
    expect(error).toContain("401");
    // ServiceM8's own error body (an HTML page in an outage) belongs in the log, not on screen.
    expect(error).not.toContain("nope");
  });
});

describe("handleServiceM8ContactLookup failures after the first page", () => {
  beforeEach(clearTables);
  afterEach(() => vi.unstubAllGlobals());

  // The run already holds matches from earlier pages; one bad search on a small last page must not
  // throw them all away by reading as an outage.
  it("counts a failed search on a later page instead of refusing the whole page", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    stubServiceM8({}, { searchStatus: 503 });
    const res = await handleServiceM8ContactLookup(post({ after: "+61400000000" }), lookupEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matches: [], checked: 1, failed: 1, next: null });
  });

  // The search worked; only the name fallback did not. That is "no name", not "ServiceM8 refused".
  it("treats a failed job-contact lookup as no name found, not a failed search", async () => {
    await seedCall("CA1", "inbound", "+61400000001", "+61261059771", 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/search.json")) return json({ results: [{ type: "job", uuid: "j1", title: "Warehouse" }] });
        if (url.includes("/jobcontact.json")) return json({ error: "forbidden" }, 403);
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const res = await handleServiceM8ContactLookup(post({}), lookupEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matches: [], checked: 1, failed: 0 });
  });
});

describe("handleServiceM8ContactSave", () => {
  beforeEach(clearTables);

  const save = (contacts: unknown) =>
    handleServiceM8ContactSave(new Request("https://x", { method: "POST", body: JSON.stringify({ contacts }) }), env.DB);

  it("saves new contacts and never overwrites one saved in the meantime", async () => {
    await createContact(env.DB, { name: "Mum", phone: "0400 000 002", company: null });

    const res = await save([
      { phone: "+61400000001", name: "Sue Dunkley" },
      { phone: "+61400000002", name: "Someone From ServiceM8" },
      { phone: "+61400000001", name: "Sue Again" },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: 1, skipped: 2 });

    const rows = await env.DB.prepare("SELECT name, phone_normalized FROM contacts ORDER BY phone_normalized").all<{ name: string; phone_normalized: string }>();
    expect(rows.results).toEqual([
      { name: "Sue Dunkley", phone_normalized: "61400000001" },
      { name: "Mum", phone_normalized: "61400000002" },
    ]);
  });

  // D1 on the free plan caps the queries one request may run; a save of every tick in one go must
  // not scale its query count with the number of contacts.
  it("saves any number of contacts in a single query", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    const many = Array.from({ length: 60 }, (_, i) => ({ phone: `+614000002${String(i).padStart(2, "0")}`, name: `Customer ${i}` }));
    try {
      const res = await save(many);
      expect(await res.json()).toEqual({ saved: 60, skipped: 0 });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(batch).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      batch.mockRestore();
    }
  });

  it("refuses an entry with no name or no number, naming it, and saves nothing", async () => {
    const res = await save([
      { phone: "+61400000001", name: "Sue" },
      { phone: "n/a", name: "Jo" },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("n/a");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("the sync routes are admin-only", () => {
  afterEach(async () => {
    await env.DB.prepare("UPDATE staff_users SET role = 'admin' WHERE email = ?").bind(DEV).run();
  });

  for (const path of ["/api/admin/servicem8/contact-lookup", "/api/admin/servicem8/contact-save"]) {
    it(`refuses a staff member on ${path}`, async () => {
      await env.DB.prepare("UPDATE staff_users SET role = 'staff' WHERE email = ?").bind(DEV).run();
      const res = await SELF.fetch("https://example.com" + path, { method: "POST", body: "{}" });
      expect(res.status).toBe(403);
    });
  }

  // Reaches the real handler: the test pool sets no ServiceM8 key, so an admin hears exactly that.
  it("routes an admin to the lookup", async () => {
    await env.DB.prepare("UPDATE staff_users SET role = 'admin' WHERE email = ?").bind(DEV).run();
    const res = await SELF.fetch("https://example.com/api/admin/servicem8/contact-lookup", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });
});

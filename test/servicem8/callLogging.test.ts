import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logCallAndSyncContact, type LoggableCall } from "../../src/servicem8/callLogging";
import { findContactByPhone } from "../../src/db/contacts";

const SUE = "+61402430107";

// The exact shape production returns for a search on 0402430107.
const SEARCH_BODY = {
  results: [
    {
      type: "job",
      uuid: "01a0558d-a4f0-7e29-bef1-58902870730d",
      title: "Job #956 - Sue Dunkley",
      data: { edit_date: "2026-09-04 12:49:16", generated_job_id: "956", status: "Completed" },
    },
    {
      type: "company",
      uuid: "01a0558f-1d6e-7e29-bef0-df59d503b9bb",
      title: "Company [01a0558f]",
      data: { edit_date: "2026-08-31 12:03:57", name: "Sue Dunkley" },
    },
  ],
};

const CALL: LoggableCall = {
  direction: "inbound",
  callerNumber: SUE,
  calledNumber: "+61261059771",
  startedAt: 1_788_499_727_502,
  endedAt: 1_788_499_827_502,
  status: "completed",
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

// Routes by URL so each test only says what differs. Returns the recorded requests.
function stubFetch(handlers: { search?: () => Promise<Response>; note?: () => Promise<Response>; jobcontact?: () => Promise<Response> }) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/search.json")) return (handlers.search ?? (() => json(SEARCH_BODY)))();
    if (url.includes("/note.json")) return (handlers.note ?? (() => json({ uuid: "note-1" })))();
    if (url.includes("/jobcontact.json")) return (handlers.jobcontact ?? (() => json([])))();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("logCallAndSyncContact", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM contacts WHERE phone_normalized = '61402430107'").run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The reported failure: the caller IS in ServiceM8, and no contact was ever made in TCB Phone.
  it("creates the TCB Phone contact from the ServiceM8 customer name", async () => {
    stubFetch({});
    await logCallAndSyncContact(env.DB, "key", CALL);
    const contact = await findContactByPhone(env.DB, SUE);
    expect(contact?.name).toBe("Sue Dunkley");
    expect(contact?.phone_normalized).toBe("61402430107");
  });

  it("logs the diary note on the matched job", async () => {
    const calls = stubFetch({});
    await logCallAndSyncContact(env.DB, "key", CALL);
    expect(calls.some((u) => u.includes("/note.json"))).toBe(true);
  });

  // Both halves used to run their own lookup for the same number on the same call.
  it("searches ServiceM8 once, not once per task", async () => {
    const calls = stubFetch({});
    await logCallAndSyncContact(env.DB, "key", CALL);
    expect(calls.filter((u) => u.includes("/search.json"))).toHaveLength(1);
  });

  // The company name is right there in the search results, so the exact-match jobcontact lookup
  // (which missed any number stored with spaces) should not be needed at all.
  it("does not fall back to jobcontact when the search already named them", async () => {
    const calls = stubFetch({});
    await logCallAndSyncContact(env.DB, "key", CALL);
    expect(calls.some((u) => u.includes("/jobcontact.json"))).toBe(false);
  });

  it("falls back to jobcontact when the search results carry no name", async () => {
    stubFetch({
      search: () => json({ results: [{ type: "job", uuid: "j1", title: "Warehouse restock", data: { edit_date: "2026-09-01 00:00:00" } }] }),
      jobcontact: () => json([{ first: "Renji", last: "Mathew", mobile: "0415 619 306" }]),
    });
    await logCallAndSyncContact(env.DB, "key", CALL);
    expect((await findContactByPhone(env.DB, SUE))?.name).toBe("Renji Mathew");
  });

  // Independence matters: these are two unrelated jobs sharing one search.
  it("still creates the contact when the note POST fails", async () => {
    stubFetch({ note: () => json({ error: "nope" }, 500) });
    await logCallAndSyncContact(env.DB, "key", CALL);
    expect((await findContactByPhone(env.DB, SUE))?.name).toBe("Sue Dunkley");
  });

  it("never overwrites a contact that already exists", async () => {
    await env.DB
      .prepare("INSERT INTO contacts (name, company, phone, phone_normalized, created_at, updated_at) VALUES ('Existing Name', NULL, ?, '61402430107', 1, 1)")
      .bind(SUE)
      .run();
    stubFetch({});
    await logCallAndSyncContact(env.DB, "key", CALL);
    expect((await findContactByPhone(env.DB, SUE))?.name).toBe("Existing Name");
  });

  // A bad or missing API key looks exactly like this, and it used to be swallowed in silence.
  it("logs and gives up when the search fails, without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ search: () => json({ error: "unauthorized" }, 401) });
    // "failed" is what tells the queue to leave the call pending and try again later.
    await expect(logCallAndSyncContact(env.DB, "key", CALL)).resolves.toBe("failed");
    expect(await findContactByPhone(env.DB, SUE)).toBeNull();
    expect(error).toHaveBeenCalledWith("SERVICEM8_SEARCH_FAILED", expect.stringContaining("401"));
  });

  it("does nothing at all for a non-AU number, and is never retried for one", async () => {
    const calls = stubFetch({});
    await expect(logCallAndSyncContact(env.DB, "key", { ...CALL, callerNumber: "+14155550100" })).resolves.toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("reports a caller ServiceM8 has never heard of as done, not as a failure to retry", async () => {
    stubFetch({ search: () => json({ results: [] }) });
    await expect(logCallAndSyncContact(env.DB, "key", CALL)).resolves.toBe("no-match");
  });

  it("uses the number that was called on an outbound call", async () => {
    const calls = stubFetch({});
    await logCallAndSyncContact(env.DB, "key", { ...CALL, direction: "outbound", callerNumber: "+61261059771", calledNumber: SUE });
    expect(calls[0]).toContain("0402430107");
    expect((await findContactByPhone(env.DB, SUE))?.name).toBe("Sue Dunkley");
  });
});

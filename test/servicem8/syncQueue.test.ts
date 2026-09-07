import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncPendingCallsToServiceM8, SERVICEM8_SYNC_DELAY_MS, SERVICEM8_SYNC_WINDOW_MS } from "../../src/servicem8/syncQueue";

const SUE = "+61402430107";
const MINUTE = 60 * 1000;

const SEARCH_BODY = {
  results: [
    { type: "job", uuid: "job-956", title: "Job #956 - Sue Dunkley", data: { edit_date: "2026-09-04 12:49:16", generated_job_id: "956", status: "Completed" } },
    { type: "company", uuid: "co-1", title: "Company [x]", data: { name: "Sue Dunkley" } },
  ],
};

function stubFetch(searchStatus = 200) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/search.json")) {
        return Promise.resolve(new Response(JSON.stringify(searchStatus === 200 ? SEARCH_BODY : { error: "nope" }), { status: searchStatus }));
      }
      return Promise.resolve(new Response(JSON.stringify({ uuid: "note-1" }), { status: 200 }));
    })
  );
  return urls;
}

async function insertCall(id: string, endedAgoMs: number | null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, direction, status, ended_at) VALUES (?, ?, '+61261059771', ?, 'inbound', 'completed', ?)"
  )
    .bind(id, SUE, now - 10 * MINUTE, endedAgoMs === null ? null : now - endedAgoMs)
    .run();
}

async function syncedAt(id: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT servicem8_synced_at FROM calls WHERE id = ?").bind(id).first<{ servicem8_synced_at: number | null }>();
  return row?.servicem8_synced_at ?? null;
}

describe("syncPendingCallsToServiceM8", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare("DELETE FROM contacts WHERE phone_normalized = '61402430107'").run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const withKey = { DB: env.DB, SERVICEM8_API_KEY: "key" };

  // The point of the whole queue: staff are still typing the customer into ServiceM8.
  it("leaves a call that only just ended alone", async () => {
    await insertCall("c-fresh", 1 * MINUTE);
    const urls = stubFetch();
    await syncPendingCallsToServiceM8(withKey);
    expect(urls).toHaveLength(0);
    expect(await syncedAt("c-fresh")).toBeNull();
  });

  it("processes a call once it is past the delay, and names the caller", async () => {
    await insertCall("c-ready", SERVICEM8_SYNC_DELAY_MS + MINUTE);
    const urls = stubFetch();
    await syncPendingCallsToServiceM8(withKey);
    expect(urls.some((u) => u.includes("/search.json"))).toBe(true);
    const contact = await env.DB.prepare("SELECT name FROM contacts WHERE phone_normalized = '61402430107'").first<{ name: string }>();
    expect(contact?.name).toBe("Sue Dunkley");
    expect(await syncedAt("c-ready")).not.toBeNull();
  });

  it("does not reach back over history -- the first tick after deploy must not note every old call", async () => {
    await insertCall("c-ancient", SERVICEM8_SYNC_WINDOW_MS + MINUTE);
    const urls = stubFetch();
    await syncPendingCallsToServiceM8(withKey);
    expect(urls).toHaveLength(0);
  });

  it("ignores a call that has not ended", async () => {
    await insertCall("c-live", null);
    const urls = stubFetch();
    await syncPendingCallsToServiceM8(withKey);
    expect(urls).toHaveLength(0);
  });

  it("does the work once, however many times the sweep runs", async () => {
    await insertCall("c-once", SERVICEM8_SYNC_DELAY_MS + MINUTE);
    const urls = stubFetch();
    await syncPendingCallsToServiceM8(withKey);
    await syncPendingCallsToServiceM8(withKey);
    expect(urls.filter((u) => u.includes("/note.json"))).toHaveLength(1);
  });

  // Two ticks overlapping must not post the diary note twice -- staff would see both in ServiceM8.
  it("claims each call before working it, so overlapping ticks can't double-post", async () => {
    await insertCall("c-race", SERVICEM8_SYNC_DELAY_MS + MINUTE);
    const urls = stubFetch();
    await Promise.all([syncPendingCallsToServiceM8(withKey), syncPendingCallsToServiceM8(withKey)]);
    expect(urls.filter((u) => u.includes("/note.json"))).toHaveLength(1);
  });

  // A revoked key is fixed outside this code; the call should still be waiting when it is.
  it("releases the claim when the search fails, so a later tick retries", async () => {
    await insertCall("c-retry", SERVICEM8_SYNC_DELAY_MS + MINUTE);
    stubFetch(401);
    await syncPendingCallsToServiceM8(withKey);
    expect(await syncedAt("c-retry")).toBeNull();
  });

  it("says so once per tick when no API key is configured, and touches nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await insertCall("c-nokey", SERVICEM8_SYNC_DELAY_MS + MINUTE);
    const urls = stubFetch();
    await syncPendingCallsToServiceM8({ DB: env.DB });
    expect(urls).toHaveLength(0);
    expect(await syncedAt("c-nokey")).toBeNull();
    expect(log).toHaveBeenCalledWith("SERVICEM8_DISABLED", expect.stringContaining('"pending":1'));
  });
});

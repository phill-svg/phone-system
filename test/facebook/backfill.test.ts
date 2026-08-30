import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillFacebookNames, MAX_NAME_ATTEMPTS, RETRY_AFTER_MS } from "../../src/facebook/backfill";

// A stand-in for D1: records every statement it is asked to prepare, answers the one SELECT with
// whatever psids the test wants swept. Enough to check the control flow (what gets written when a
// lookup succeeds vs fails) without the workers pool, which can't start in every environment.
function fakeDb(psids: string[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const record = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          record.params = params;
          calls.push(record);
          return this;
        },
        async all() {
          return { results: psids.map((psid) => ({ psid })) };
        },
        async run() {
          return { success: true };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, calls };
}

const ok = (name: string) => ({ ok: true, json: async () => ({ name }) });
const dead = {
  ok: false,
  status: 400,
  json: async () => ({ error: { message: "Session has expired.", type: "OAuthException", code: 190 } }),
};

describe("backfillFacebookNames", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing at all without a Page token", async () => {
    const { db, calls } = fakeDb(["psid-1"]);
    expect(await backfillFacebookNames({ DB: db })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("caches the name and clears the bookkeeping row when the lookup works", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("Gabby Nguyen")));
    const { db, calls } = fakeDb(["psid-1"]);
    expect(await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" })).toBe(1);
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO fb_contacts") && c.params.includes("Gabby Nguyen"))).toBe(true);
    expect(calls.some((c) => c.sql.startsWith("DELETE FROM fb_name_attempts"))).toBe(true);
  });

  it("records Facebook's reason when the lookup fails, and resolves nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dead));
    const { db, calls } = fakeDb(["psid-1"]);
    expect(await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" })).toBe(0);
    const attempt = calls.find((c) => c.sql.startsWith("INSERT INTO fb_name_attempts"));
    expect(attempt).toBeDefined();
    expect(String(attempt?.params[2])).toContain("Session has expired.");
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO fb_contacts"))).toBe(false);
  });

  it("asks only for senders under the attempt cap and past the retry interval", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("X")));
    const now = 1_700_000_000_000;
    const { db, calls } = fakeDb(["psid-1"]);
    await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" }, 5, now);
    const select = calls.find((c) => c.sql.includes("FROM messages"));
    expect(select?.params).toEqual([MAX_NAME_ATTEMPTS, now - RETRY_AFTER_MS, 5]);
  });

  it("sweeps every sender it was handed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok("Someone"));
    vi.stubGlobal("fetch", fetchMock);
    const { db } = fakeDb(["psid-1", "psid-2", "psid-3"]);
    expect(await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" })).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

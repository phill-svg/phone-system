import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillFacebookNames, isTokenLevelFailure, MAX_NAME_ATTEMPTS, RETRY_AFTER_MS } from "../../src/facebook/backfill";

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

  // The attempt cap exists to stop asking about a psid the token can never read (Graph code 100).
  // A DEAD TOKEN fails identically for everyone and says nothing about any one psid, so counting it
  // burned the cap on the whole backlog: six hours later every pending psid is past the cap and
  // excluded permanently, and fixing the token afterwards cannot bring those names back.
  it("does not count a dead-token failure against the attempt cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(dead));
    const { db, calls } = fakeDb(["psid-1"]);
    await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" });
    const attempt = calls.find((c) => c.sql.startsWith("INSERT INTO fb_name_attempts"));
    // The reason and the timestamp are still recorded -- the retry interval still spaces these out.
    expect(String(attempt?.params[2])).toContain("Session has expired.");
    // ...but the count stays put, so the next tick after the token is fixed may still ask.
    expect(attempt?.sql).toContain("VALUES (?, 0, ?, ?)");
    expect(attempt?.sql).not.toContain("attempts = attempts + 1");
  });

  // A refusal that IS about this psid still counts, or the cap would never drain.
  it("counts a per-psid refusal against the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 },
        }),
      })
    );
    const { db, calls } = fakeDb(["psid-1"]);
    await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" });
    const attempt = calls.find((c) => c.sql.startsWith("INSERT INTO fb_name_attempts"));
    expect(attempt?.sql).toContain("attempts = attempts + 1");
  });

  it("classifies failures by whether they are about the token or the person", () => {
    expect(isTokenLevelFailure("OAuthException 190: Session has expired.")).toBe(true);
    expect(isTokenLevelFailure("Could not reach the Facebook Graph API: TypeError")).toBe(true);
    expect(isTokenLevelFailure("GraphMethodException 100: Unsupported get request.")).toBe(false);
    expect(isTokenLevelFailure("Facebook returned no name for this person.")).toBe(false);
    // Only a THROWN fetch produces "Could not reach...". A Graph incident that answers 502 with a
    // non-JSON body lands here instead, and used to count against the cap after all -- so the fix
    // did not cover the outage it was written for.
    expect(isTokenLevelFailure("Facebook returned HTTP 502.")).toBe(true);
    expect(isTokenLevelFailure("Facebook returned HTTP 429.")).toBe(true);
    expect(isTokenLevelFailure("Facebook returned HTTP 404.")).toBe(false);
  });

  it("sweeps every sender it was handed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok("Someone"));
    vi.stubGlobal("fetch", fetchMock);
    const { db } = fakeDb(["psid-1", "psid-2", "psid-3"]);
    expect(await backfillFacebookNames({ DB: db, FB_PAGE_ACCESS_TOKEN: "t" })).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

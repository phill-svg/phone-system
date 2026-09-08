import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseClientErrorReport,
  recordClientErrors,
  listClientErrors,
  MAX_REPORTS_PER_BATCH,
} from "../../src/db/clientErrors";

const base = {
  platform: "ios",
  otaBuild: "52",
  appVersion: "1.0.0",
  fatal: true,
  name: "TypeError",
  message: "undefined is not an object",
  stack: "at Foo\nat Bar",
  screen: "/recents",
  occurredAt: 1_757_000_000_000,
};

describe("db/clientErrors", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM client_errors").run();
  });

  it("rejects a report with no message, since there is nothing to read", () => {
    expect(parseClientErrorReport({ ...base, message: "" })).toBeNull();
    expect(parseClientErrorReport(null)).toBeNull();
    expect(parseClientErrorReport("boom")).toBeNull();
  });

  it("keeps a report whose device clock is missing or nonsense, timestamping it on arrival", () => {
    const before = Date.now();
    const parsed = parseClientErrorReport({ ...base, occurredAt: undefined });
    expect(parsed).not.toBeNull();
    expect(parsed!.occurredAt).toBeGreaterThanOrEqual(before);
  });

  it("truncates an oversized stack rather than dropping the report", () => {
    const parsed = parseClientErrorReport({ ...base, stack: "x".repeat(50_000) });
    expect(parsed!.stack!.length).toBeLessThanOrEqual(8000);
    expect(parsed!.message).toBe(base.message);
  });

  it("treats a non-boolean fatal flag as not fatal", () => {
    expect(parseClientErrorReport({ ...base, fatal: "yes" })!.fatal).toBe(false);
    expect(parseClientErrorReport({ ...base, fatal: true })!.fatal).toBe(true);
  });

  it("stores a batch and reads it back newest-first", async () => {
    await recordClientErrors(env.DB, "phill@example.com", [
      parseClientErrorReport({ ...base, message: "older", occurredAt: 1000 })!,
      parseClientErrorReport({ ...base, message: "newer", occurredAt: 2000 })!,
    ]);
    const rows = await listClientErrors(env.DB);
    expect(rows.map((r) => r.message)).toEqual(["newer", "older"]);
    expect(rows[0].staff_email).toBe("phill@example.com");
    expect(rows[0].fatal).toBe(1);
    // received_at is ours, occurred_at is the device's -- the gap is how a fatal crash is spotted.
    expect(rows[0].received_at).toBeGreaterThan(rows[0].occurred_at);
  });

  it("writing an empty batch touches nothing", async () => {
    expect(await recordClientErrors(env.DB, "phill@example.com", [])).toBe(0);
    expect(await listClientErrors(env.DB)).toEqual([]);
  });

  it("caps a batch, so a crash-looping handset cannot flood the table", () => {
    expect(MAX_REPORTS_PER_BATCH).toBeLessThanOrEqual(50);
  });
});

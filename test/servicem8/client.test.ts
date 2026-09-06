import { describe, it, expect } from "vitest";
import { pickMostRecentJob, pickCustomerName, phoneVariants, type Sm8SearchResult } from "../../src/servicem8/client";

// Shaped from a real production search for 0402430107 (a job result plus the company record whose
// `name` IS the customer). Kept verbatim-ish so a change in our parsing is caught against the real
// payload, not against a convenient invention.
const REAL_RESULTS: Sm8SearchResult[] = [
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
    data: { edit_date: "2026-08-31 12:03:57", name: "Sue Dunkley", is_individual: 1 },
  },
];

describe("pickCustomerName", () => {
  it("takes the name from the company record", () => {
    expect(pickCustomerName(REAL_RESULTS)).toBe("Sue Dunkley");
  });

  it("falls back to the job title when no company record came back", () => {
    expect(pickCustomerName([REAL_RESULTS[0]])).toBe("Sue Dunkley");
  });

  it("returns null rather than a garbage name for a job titled something else", () => {
    expect(pickCustomerName([{ type: "job", uuid: "u", title: "Warehouse restock" }])).toBeNull();
  });

  it("ignores a company record with a blank name", () => {
    expect(pickCustomerName([{ type: "company", uuid: "u", title: "Company [x]", data: { name: "  " } }])).toBeNull();
  });
});

describe("pickMostRecentJob", () => {
  const job = (uuid: string, edit_date: string, status = "Work Order"): Sm8SearchResult => ({
    type: "job",
    uuid,
    title: `Job #1 - X`,
    data: { edit_date, status, generated_job_id: "1" },
  });

  it("returns null when nothing matched", () => {
    expect(pickMostRecentJob([])).toBeNull();
    expect(pickMostRecentJob([REAL_RESULTS[1]])).toBeNull(); // company only
  });

  it("picks the most recently edited job", () => {
    const picked = pickMostRecentJob([job("old", "2026-01-01 00:00:00"), job("new", "2026-09-01 00:00:00")]);
    expect(picked?.uuid).toBe("new");
  });

  it("skips an Unsuccessful job when a live one exists, but takes it when it's the only one", () => {
    const results = [job("dead", "2026-09-05 00:00:00", "Unsuccessful"), job("live", "2026-01-01 00:00:00")];
    expect(pickMostRecentJob(results)?.uuid).toBe("live");
    expect(pickMostRecentJob([results[0]])?.uuid).toBe("dead");
  });
});

describe("phoneVariants", () => {
  // The old filter sent only the bare local form, so a number stored as "0402 430 107" -- which is
  // how ServiceM8 displays them -- matched nothing and the customer was never named.
  it("covers the formats an AU mobile is actually stored in", () => {
    const variants = phoneVariants("+61402430107");
    expect(variants).toContain("0402430107");
    expect(variants).toContain("0402 430 107");
    expect(variants).toContain("+61402430107");
    expect(variants).toContain("61402430107");
  });

  it("groups a landline the way it is written", () => {
    expect(phoneVariants("+61261059771")).toContain("02 6105 9771");
  });

  it("de-duplicates", () => {
    const variants = phoneVariants("+61402430107");
    expect(new Set(variants).size).toBe(variants.length);
  });
});

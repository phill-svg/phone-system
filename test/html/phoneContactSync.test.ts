import { describe, expect, it } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// Admin > Sync contacts on the web/desktop Phone page. The REAL emitted paging code runs here
// against a scripted fetch, so a regression in phone.ts has to reach this test.

type Reply = { ok: boolean; status: number; body: unknown };

function harness(replies: Reply[]) {
  const html = renderPhonePage("phill@b.com", "admin");
  const code = /(async function lookupAllInServiceM8[\s\S]*?)\n\s*\/\/ end lookupAllInServiceM8/.exec(html)?.[1];
  if (!code) throw new Error("could not find lookupAllInServiceM8 in the emitted phone script");
  const sent: unknown[] = [];
  const fetch = (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const r = replies.shift();
    if (!r) return Promise.reject(new Error("no more scripted replies"));
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
  };
  const run = new Function("fetch", `${code}\n return lookupAllInServiceM8;`);
  const lookup = run(fetch) as (onProgress: (done: number, total: number) => void) => Promise<{ matches: unknown[]; failed: number }>;
  return { lookup, sent };
}

const page = (matches: unknown[], checked: number, total: number, remaining: number, next: string | null, failed = 0): Reply => ({
  ok: true,
  status: 200,
  body: { matches, checked, failed, total, remaining, next },
});

describe("Sync contacts on the Phone page", () => {
  it("shows the button to an admin only", () => {
    expect(renderPhonePage("phill@b.com", "admin")).toContain('id="contact-sync-btn"');
    expect(renderPhonePage("mate@b.com", "staff")).not.toContain('id="contact-sync-btn"');
  });

  it("asks for the next batch until there is none, collecting every match", async () => {
    const sue = { phone: "+61400000001", name: "Sue", lastSeen: 1 };
    const jo = { phone: "+61400000020", name: "Jo", lastSeen: 2 };
    const { lookup, sent } = harness([page([sue], 15, 20, 5, "+61400000015"), page([jo], 5, 20, 0, null, 1)]);
    const progress: Array<[number, number]> = [];

    const result = await lookup((done, total) => progress.push([done, total]));

    expect(result.matches).toEqual([sue, jo]);
    expect(result.failed).toBe(1);
    expect(sent).toEqual([{}, { after: "+61400000015" }]);
    expect(progress.at(-1)).toEqual([20, 20]);
  });

  it("stops with the server's own words when it refuses", async () => {
    const { lookup } = harness([{ ok: false, status: 503, body: { error: "ServiceM8 isn't connected" } }]);
    await expect(lookup(() => {})).rejects.toThrow("ServiceM8 isn't connected");
  });

  // A cursor that does not move would loop forever, firing ServiceM8 searches each time round.
  it("stops rather than loop when the cursor does not advance", async () => {
    const { lookup, sent } = harness([page([], 15, 40, 25, "+61400000015"), page([], 15, 40, 25, "+61400000015")]);
    await expect(lookup(() => {})).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });
});

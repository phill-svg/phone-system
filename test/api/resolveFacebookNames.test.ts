import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResolveFacebookNames } from "../../src/api/facebook";

// The manual "refresh names" button used ONLY the per-psid profile lookup, which Facebook refuses
// with code 100 for every ordinary customer. It must ask the Page's own inbox first, like the
// webhook and the cron do, and fall back per-psid only for whoever the inbox does not list.
const PAGE = "626021143926639";
const refused = {
  ok: false,
  status: 400,
  json: async () => ({ error: { message: "cannot be loaded due to missing permissions", type: "GraphMethodException", code: 100 } }),
};

describe("handleResolveFacebookNames", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM fb_contacts").run();
    await env.DB.prepare("DELETE FROM messages").run();
    for (const psid of ["111", "222"]) {
      await env.DB.prepare(
        "INSERT INTO messages (id, direction, peer_number, body, status, created_at) VALUES (?, 'inbound', ?, 'hi', 'received', 1)"
      )
        .bind(`SM${psid}`, `messenger:${psid}`)
        .run();
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names customers from the Page inbox when the per-psid lookup is refused", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/conversations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ participants: { data: [{ id: "111", name: "Jane Customer" }, { id: PAGE, name: "TCB" }] } }],
          }),
        };
      }
      return refused;
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleResolveFacebookNames(env.DB, "tok", `messenger:${PAGE}`);
    const body = (await res.json()) as { checked: number; resolved: string[]; failed: { psid: string }[] };

    expect(body.checked).toBe(2);
    expect(body.resolved).toEqual(["Jane Customer"]);
    expect(body.failed.map((f) => f.psid)).toEqual(["222"]);
    const row = await env.DB.prepare("SELECT name FROM fb_contacts WHERE psid = '111'").first<{ name: string }>();
    expect(row?.name).toBe("Jane Customer");
    // 111 was named by the inbox, so only 222 fell through to the per-psid call.
    const perPsid = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes("/conversations"));
    expect(perPsid).toHaveLength(1);
    expect(perPsid[0]).toContain("/222");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageInboxNames } from "../../src/facebook/pageInbox";

const PAGE = "626021143926639";

function convo(participants: { id: string; name: string }[]) {
  return { participants: { data: participants } };
}

function stubJson(...pages: unknown[]) {
  const fn = vi.fn();
  for (const body of pages) {
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("fetchPageInboxNames", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The case the User Profile API refuses with code 100: an ordinary customer.
  it("maps each participant psid to their name", async () => {
    stubJson({
      data: [
        convo([
          { id: "26199020283111854", name: "Corey Allen" },
          { id: PAGE, name: "TCB Pest Control Canberra" },
        ]),
        convo([
          { id: "38022685257378113", name: "Jo Van" },
          { id: PAGE, name: "TCB Pest Control Canberra" },
        ]),
      ],
    });
    const out = await fetchPageInboxNames(PAGE, "token");
    if (!("names" in out)) throw new Error(out.error);
    expect(out.names.get("26199020283111854")).toBe("Corey Allen");
    expect(out.names.get("38022685257378113")).toBe("Jo Van");
  });

  // The Page is a participant in every thread; storing it would name a customer after ourselves.
  it("never returns the page itself as a sender", async () => {
    stubJson({ data: [convo([{ id: PAGE, name: "TCB Pest Control Canberra" }])] });
    const out = await fetchPageInboxNames(PAGE, "token");
    if (!("names" in out)) throw new Error(out.error);
    expect(out.names.size).toBe(0);
  });

  it("follows paging to collect later threads", async () => {
    const fn = stubJson(
      {
        data: [convo([{ id: "psid-1", name: "First Person" }])],
        paging: { next: "https://graph.facebook.com/next-page" },
      },
      { data: [convo([{ id: "psid-2", name: "Second Person" }])] }
    );
    const out = await fetchPageInboxNames(PAGE, "token");
    if (!("names" in out)) throw new Error(out.error);
    expect(out.names.get("psid-2")).toBe("Second Person");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops after the page cap rather than crawling forever", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], paging: { next: "https://graph.facebook.com/again" } }),
    });
    vi.stubGlobal("fetch", fn);
    await fetchPageInboxNames(PAGE, "token");
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("reports a Graph error instead of pretending the inbox was empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Invalid OAuth token", type: "OAuthException", code: 190 } }),
      })
    );
    const out = await fetchPageInboxNames(PAGE, "token");
    expect("error" in out && out.error).toContain("190");
  });

  it("reports a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const out = await fetchPageInboxNames(PAGE, "token");
    expect("error" in out && out.error).toContain("network down");
  });

  it("errors when no page id is configured", async () => {
    const out = await fetchPageInboxNames("", "token");
    expect("error" in out && out.error).toContain("Page id");
  });
});

import { describe, expect, it } from "vitest";
import { isDemoUser, handleDemoRequest } from "../../src/demo";
import { demoCalls, demoContacts, demoConversations, demoThread } from "../../src/demo/fixtures";

const NOW = 1_788_000_000_000;
const req = (path: string, method = "GET") => new Request("https://x" + path, { method });

describe("isDemoUser", () => {
  const env = { DEMO_ACCOUNT_EMAILS: "reviewer@tcbpestcontrolcanberra.com.au, other@example.com" };

  it("matches a configured address, ignoring case and padding", () => {
    expect(isDemoUser("Reviewer@TCBpestcontrolcanberra.com.au", env)).toBe(true);
    expect(isDemoUser(" other@example.com ", env)).toBe(true);
  });

  it("does not match a real staff member", () => {
    expect(isDemoUser("phill@tcbpestcontrolcanberra.com.au", env)).toBe(false);
  });

  // The var is absent in tests and in any deployment that hasn't set it. Nobody gets demo data by
  // accident -- an empty list must never match, least of all an empty email.
  it("matches nobody when unset or empty", () => {
    expect(isDemoUser("reviewer@tcbpestcontrolcanberra.com.au", {})).toBe(false);
    expect(isDemoUser("", { DEMO_ACCOUNT_EMAILS: "" })).toBe(false);
    expect(isDemoUser("", { DEMO_ACCOUNT_EMAILS: "a@b.com" })).toBe(false);
  });
});

describe("demo request handling", () => {
  async function body(res: Response | null): Promise<any> {
    expect(res).not.toBeNull();
    return await res!.json();
  }

  it("serves invented conversations, threads, calls and contacts", async () => {
    expect(await body(handleDemoRequest(new URL("https://x/api/messages"), req("/api/messages"), NOW)))
      .toEqual(demoConversations(NOW));
    expect(await body(handleDemoRequest(new URL("https://x/api/calls"), req("/api/calls"), NOW)))
      .toEqual(demoCalls(NOW));
    expect(await body(handleDemoRequest(new URL("https://x/api/contacts"), req("/api/contacts"), NOW)))
      .toEqual(demoContacts(NOW));

    const peer = encodeURIComponent("+61491570006");
    const thread = await body(handleDemoRequest(new URL(`https://x/api/messages/${peer}`), req(`/api/messages/${peer}`), NOW));
    expect(thread).toEqual(demoThread(NOW, "+61491570006"));
    expect(thread.length).toBeGreaterThan(0);
  });

  // The whole point: a reviewer tapping Send must not put an SMS or a Messenger reply in front of
  // a real person. The handler answers instead of the real one, so nothing is dispatched.
  it("swallows sends and other writes without touching anything", async () => {
    for (const [path, method] of [
      ["/api/messages", "POST"],
      ["/api/contacts", "POST"],
      ["/api/contacts/3", "PUT"],
      ["/api/contacts/3", "DELETE"],
      ["/api/calls/DEMO-c01", "PATCH"],
    ] as const) {
      const res = handleDemoRequest(new URL("https://x" + path), req(path, method), NOW);
      expect(res, `${method} ${path}`).not.toBeNull();
      expect(res!.status, `${method} ${path}`).toBe(200);
      expect(await res!.json()).toEqual({ ok: true });
    }
  });

  it("returns one demo call by id, and 404s an unknown one", async () => {
    const hit = handleDemoRequest(new URL("https://x/api/calls/DEMO-c01"), req("/api/calls/DEMO-c01"), NOW);
    expect((await body(hit)).id).toBe("DEMO-c01");
    const miss = handleDemoRequest(new URL("https://x/api/calls/CA-real-call"), req("/api/calls/CA-real-call"), NOW);
    expect(miss!.status).toBe(404);
  });

  // "live" is not a call id. Without its own rule it falls into the /api/calls/:id matcher and the
  // app's live-call poll starts 404ing.
  it("answers the live-calls poll with an empty list, not a 404", async () => {
    const res = handleDemoRequest(new URL("https://x/api/calls/live"), req("/api/calls/live"), NOW);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  // Outbound calling is the app's central claim and App Review has to be able to test it, so the
  // softphone endpoints deliberately fall through to the real handlers.
  it("leaves calling, identity and the business's own numbers alone", () => {
    for (const path of ["/api/softphone/token", "/api/me", "/api/numbers", "/api/settings/me", "/api/staff"]) {
      expect(handleDemoRequest(new URL("https://x" + path), req(path)), path).toBeNull();
    }
  });
});

describe("demo fixtures", () => {
  // Every number is from ACMA's ranges reserved for fiction, so nothing a reviewer taps can reach
  // a real person: mobiles 0491 570 xxx, landlines (0x) 5550 xxxx. The business's own published
  // numbers are the only other ones allowed to appear.
  const OWN_NUMBERS = ["+61261059771", "+61485034869", "+61866108941"];
  const fictitious = (n: string) =>
    OWN_NUMBERS.includes(n) || n.startsWith("messenger:") || /^\+61491570\d{3}$/.test(n) || /^\+612?5550\d{4}$/.test(n);

  it("uses only fictitious numbers", () => {
    for (const c of demoContacts(NOW)) expect(fictitious(c.phone), c.phone).toBe(true);
    for (const c of demoCalls(NOW)) {
      expect(fictitious(c.caller_number), c.caller_number).toBe(true);
      expect(fictitious(c.called_number), c.called_number).toBe(true);
    }
    for (const c of demoConversations(NOW)) expect(fictitious(c.number), c.number).toBe(true);
  });

  it("has voicemail to show: some calls carry a transcription", () => {
    // The Voicemail tab is derived from calls with a transcription, so an empty set means an empty
    // tab in front of the reviewer.
    expect(demoCalls(NOW).filter((c) => c.transcription).length).toBeGreaterThanOrEqual(2);
  });

  it("dates everything relative to now, so the demo never looks abandoned", () => {
    const later = NOW + 90 * 24 * 60 * 60 * 1000;
    const newest = Math.max(...demoCalls(later).map((c) => c.started_at));
    expect(later - newest).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it("lists conversations newest first, matching each thread's last message", () => {
    const convos = demoConversations(NOW);
    expect(convos.length).toBeGreaterThan(3);
    for (let i = 1; i < convos.length; i++) expect(convos[i - 1].last_ts).toBeGreaterThanOrEqual(convos[i].last_ts);
    for (const c of convos) {
      const thread = demoThread(NOW, c.number);
      expect(thread[thread.length - 1].body).toBe(c.last_body);
      expect(thread[thread.length - 1].ts).toBe(c.last_ts);
    }
  });

  it("includes a Facebook Messenger thread, since that inbox is a headline feature", () => {
    expect(demoConversations(NOW).some((c) => c.number.startsWith("messenger:"))).toBe(true);
  });
});

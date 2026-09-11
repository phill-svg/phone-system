/// <reference types="jest" />
/// <reference types="node" />

declare global {
  namespace NodeJS {
    interface Global {
      fetch: any;
    }
  }
}

jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { apiFetch, login, ApiError, setUnauthorizedHandler, putIvrFlow } from "../src/lib/api";
import { IVR_NODE_PUT_FIELDS } from "../src/lib/ivr";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

describe("api client", () => {
  beforeEach(() => { jest.clearAllMocks(); (session.getToken as jest.Mock).mockResolvedValue(null); });

  it("attaches a Bearer header when a token exists", async () => {
    (session.getToken as jest.Mock).mockResolvedValue("tok123");
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    (global as any).fetch = fetchMock as any;
    await apiFetch("/api/me");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok123");
  });

  it("omits Authorization when no token", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    (global as any).fetch = fetchMock as any;
    await apiFetch("/api/me");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("on 401 clears the token, fires the unauthorized handler, and throws ApiError(401)", async () => {
    (session.getToken as jest.Mock).mockResolvedValue("tok123");
    (global as any).fetch = jest.fn().mockReturnValue(okJson({ error: "unauthenticated" }, 401)) as any;
    const onUnauth = jest.fn();
    setUnauthorizedHandler(onUnauth);
    await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(session.clearToken).toHaveBeenCalled();
    expect(onUnauth).toHaveBeenCalled();
  });

  it("login posts credentials and returns token+user", async () => {
    (global as any).fetch = jest.fn().mockReturnValue(okJson({ token: "t", user: { email: "a@b.com", role: "staff" } })) as any;
    const res = await login("a@b.com", "pw");
    expect(res.token).toBe("t");
    expect(res.user.email).toBe("a@b.com");
  });
});

// The field list in toPutPayload is tested directly in ivr.test.ts, but nothing pinned the CALL
// SITE that makes it apply: reverting putIvrFlow to JSON.stringify(body) left every test green.
// That is the one mutation of the #91 fixes that survived, and it is this repo's named recurring
// failure -- so it gets its own test, at the boundary where the bytes are actually decided.
describe("putIvrFlow", () => {
  it("sends the web canvas positions, which the endpoint would otherwise destroy", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    (global as any).fetch = fetchMock as any;

    await putIvrFlow("main", {
      entryNodeId: "a",
      nodes: [
        { id: "a", flow: "main", isEntry: true, type: "play", config: { ttsText: "Hi" }, positionX: 120, positionY: 340 },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.entryNodeId).toBe("a");
    expect(body.nodes[0].positionX).toBe(120);
    expect(body.nodes[0].positionY).toBe(340);
  });

  it("sends every persisted field and no extras a delete-and-reinsert would choke on", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    (global as any).fetch = fetchMock as any;

    // A node carrying a field the server does not persist -- what a stale client, or a field
    // removed from the schema, would look like. The spread would have forwarded it verbatim.
    const node = {
      id: "a", flow: "main", isEntry: true, type: "play" as const,
      config: {}, positionX: null, positionY: null, updatedAt: 12345,
    };
    await putIvrFlow("main", { entryNodeId: "a", nodes: [node as never] });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(Object.keys(body.nodes[0]).sort()).toEqual([...IVR_NODE_PUT_FIELDS].sort());
  });
});

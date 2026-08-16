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
import { apiFetch, login, ApiError, setUnauthorizedHandler } from "../src/lib/api";

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

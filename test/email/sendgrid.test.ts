import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail, inviteEmail, resetEmail } from "../../src/email/sendgrid";

const ENV = { SENDGRID_API_KEY: "SG.test", AUTH_FROM_EMAIL: "no-reply@tcbpestcontrolcanberra.com.au" };

describe("sendgrid client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the SendGrid API with auth + payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail(ENV, { to: "jake@example.com", subject: "Hi", html: "<p>Hi</p>" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer SG.test" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.personalizations[0].to[0].email).toBe("jake@example.com");
    expect(body.from.email).toBe(ENV.AUTH_FROM_EMAIL);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 401 })));
    await expect(sendEmail(ENV, { to: "x@y.com", subject: "s", html: "h" })).rejects.toThrow(/401/);
  });

  it("throws when config is missing", async () => {
    await expect(sendEmail({}, { to: "x@y.com", subject: "s", html: "h" })).rejects.toThrow(/not configured/);
  });

  it("templates embed the link", () => {
    expect(inviteEmail("https://x/set-password?token=abc").html).toContain("https://x/set-password?token=abc");
    expect(resetEmail("https://x/set-password?token=def").html).toContain("https://x/set-password?token=def");
  });
});

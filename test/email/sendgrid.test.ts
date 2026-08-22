import { describe, expect, it, vi } from "vitest";
import { sendEmail, inviteEmail, resetEmail } from "../../src/email/sendgrid";

describe("email (Cloudflare send_email binding)", () => {
  it("calls the EMAIL binding with the verified sender + recipient", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await sendEmail({ EMAIL: { send } }, { to: "jake@example.com", subject: "Hi", html: "<p>Hi</p>" });
    expect(send).toHaveBeenCalledOnce();
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jake@example.com");
    expect(msg.from).toBe("noreply@mail.tcbpestcontrolcanberra.com.au");
    expect(msg.subject).toBe("Hi");
    expect(msg.html).toBe("<p>Hi</p>");
    // A plain-text part is always derived from the HTML for deliverability.
    expect(msg.text).toContain("Hi");
  });

  it("throws when the EMAIL binding is missing", async () => {
    await expect(sendEmail({}, { to: "x@y.com", subject: "s", html: "h" })).rejects.toThrow(/EMAIL binding not configured/);
  });

  it("templates embed the link", () => {
    expect(inviteEmail("https://x/set-password?token=abc").html).toContain("https://x/set-password?token=abc");
    expect(resetEmail("https://x/set-password?token=def").html).toContain("https://x/set-password?token=def");
  });
});

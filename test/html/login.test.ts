// test/html/login.test.ts
import { describe, expect, it } from "vitest";
import { renderLoginPage, renderForgotPasswordPage, renderSetPasswordPage } from "../../src/html/pages/login";

describe("auth pages", () => {
  it("login page has email+password fields posting to /login and TCB branding", () => {
    const html = renderLoginPage();
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain("TCB VoIP");
    expect(html).toContain("#e4002b");
    expect(html).not.toContain("nav-link"); // not the admin shell
  });

  it("login page shows and escapes an error", () => {
    expect(renderLoginPage({ error: "Invalid <x> & y" })).toContain("Invalid &lt;x&gt; &amp; y");
  });

  it("set-password page embeds the token in a hidden field and shows the email", () => {
    const html = renderSetPasswordPage({ token: "tok-123", email: "jake@example.com" });
    expect(html).toContain('name="token"');
    expect(html).toContain('value="tok-123"');
    expect(html).toContain("jake@example.com");
    expect(html).toContain('action="/set-password"');
  });

  it("forgot page posts to /forgot-password; done state shows neutral message", () => {
    expect(renderForgotPasswordPage()).toContain('action="/forgot-password"');
    expect(renderForgotPasswordPage({ done: true })).toContain("we've sent");
  });
});

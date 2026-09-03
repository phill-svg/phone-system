import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderSupportPage } from "../../src/html/pages/legal";

describe("support page", () => {
  it("gives a reader a way to reach a human", () => {
    const html = renderSupportPage();
    expect(html).toContain("phill@tcbpestcontrolcanberra.com.au");
    expect(html).toContain("(02) 6105 9771");
    expect(html).toContain("Monday to Friday");
  });

  it("explains how to get an account, since there is no public sign-up", () => {
    const html = renderSupportPage();
    expect(html).toContain("no public sign-up");
    expect(html).toContain("Forgot password");
  });

  it("links the privacy policy and terms, which the store listing also requires", () => {
    const html = renderSupportPage();
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
  });

  // The whole point of the page. The site root redirects to /admin/live, which bounces a logged-out
  // visitor to /login -- so without a public /support, the store listing's Support URL would land
  // App Review on a sign-in wall instead of support information.
  it("is served without a login, like /privacy and /terms", async () => {
    for (const path of ["/support", "/privacy", "/terms"]) {
      const res = await SELF.fetch("https://example.com" + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toContain("text/html");
    }
    const body = await (await SELF.fetch("https://example.com/support")).text();
    expect(body).toContain("Support");
    // Not the login page: the support copy legitimately talks about signing in, so look for the
    // form itself rather than the words.
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain('action="/login"');
  });
});

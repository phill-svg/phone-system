import { describe, expect, it } from "vitest";
import { renderClientErrorsPage } from "../../src/html/pages/clientErrors";
import type { ClientErrorRow } from "../../src/db/clientErrors";

function row(overrides: Partial<ClientErrorRow> = {}): ClientErrorRow {
  return {
    id: 1,
    staff_email: "phill@example.com",
    platform: "ios",
    ota_build: "52",
    app_version: "1.0.0",
    fatal: 1,
    name: "TypeError",
    message: "undefined is not an object",
    stack: "at Foo\nat Bar",
    screen: "/recents",
    occurred_at: 1_757_000_000_000,
    received_at: 1_757_000_000_000 + 9 * 60_000,
    ...overrides,
  };
}

describe("html/pages/clientErrors", () => {
  it("shows the error, the build it happened on, and the screen it happened on", () => {
    const html = renderClientErrorsPage([row()], "admin");
    expect(html).toContain("TypeError: undefined is not an object");
    expect(html).toContain("OTA #52");
    expect(html).toContain("/recents");
  });

  it("flags a report the device held back, which is the signature of a real crash", () => {
    expect(renderClientErrorsPage([row()], "admin")).toContain("reported 9 min later");
    const prompt = row({ received_at: 1_757_000_000_000 + 2_000 });
    expect(renderClientErrorsPage([prompt], "admin")).not.toContain("min later");
  });

  it("distinguishes a crash from one the error boundary caught", () => {
    expect(renderClientErrorsPage([row()], "admin")).toContain("Crash");
    expect(renderClientErrorsPage([row({ fatal: 0 })], "admin")).toContain("Caught");
  });

  it("escapes a stack trace rather than rendering it as markup", () => {
    const html = renderClientErrorsPage([row({ stack: '<script>alert(1)</script>' })], "admin");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so when nothing has been reported", () => {
    expect(renderClientErrorsPage([], "admin")).toContain("Nothing reported");
  });
});

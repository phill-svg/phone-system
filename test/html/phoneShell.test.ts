import { env, SELF } from "cloudflare:test";
import worker from "../../src/worker";
import { describe, expect, it, vi } from "vitest";
import { renderPhonePage, renderPhoneFrameStub } from "../../src/html/pages/phone";

// The Twilio Device exists only on the Phone page, and a full-page navigation destroys it. So a
// call rang nowhere while staff were on Messages or Voicemail, and switching back to Phone mid-ring
// showed "In progress" with no Answer: Twilio never re-offers a call to a Device that registered
// after the call started. The Phone page is now the dashboard's shell, and every other section
// opens in a frame inside it.

const page = (path: string, dest?: string) =>
  SELF.fetch(`https://example.com${path}`, { headers: dest ? { "Sec-Fetch-Dest": dest } : {}, redirect: "manual" });

describe("which requests get the shell", () => {
  it("serves a top-level section load as the Phone page with that section open", async () => {
    const res = await page("/admin/messages?to=%2B61400000000", "document");
    const html = await res.text();
    expect(html).toContain('id="section-frame"');
    expect(html).toContain('var INITIAL_SECTION = "/admin/messages?to=%2B61400000000";');
    expect(res.headers.get("Vary")).toBe("Sec-Fetch-Dest");
  });

  // The frame's plain page and the top's shell share a URL. Cached without Vary, Back could put
  // the plain page at the top -- no softphone, calls ringing nowhere.
  it("never lets the plain page be served from cache in place of the shell", async () => {
    const res = await page("/admin/voicemail", "iframe");
    expect(res.headers.get("Vary")).toBe("Sec-Fetch-Dest");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The shell is chosen after the route resolves, so a path that does not exist still 404s --
  // /admin/calls is removed on purpose and pinned as a 404 elsewhere.
  it("still 404s a page that does not exist", async () => {
    for (const path of ["/admin/calls", "/admin/calls/CA-no-such-call", "/admin/typo"]) {
      expect((await page(path, "document")).status, path).toBe(404);
    }
  });

  it("lets only the dashboard itself frame its pages", async () => {
    const res = await page("/admin/voicemail", "iframe");
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("serves the frame's own request as the plain section, with no softphone in it", async () => {
    const html = await (await page("/admin/voicemail", "iframe")).text();
    expect(html).not.toContain('id="section-frame"');
    expect(html).not.toContain("new Twilio.Device");
  });

  // A browser that sends no Sec-Fetch-Dest must never get the shell: inside a frame it would
  // nest a second softphone ringing behind the section.
  it("serves the plain section when the header is missing", async () => {
    const html = await (await page("/admin/voicemail")).text();
    expect(html).not.toContain('id="section-frame"');
  });

  it("answers /admin/phone inside the frame with the hand-over stub, not a second softphone", async () => {
    const res = await page("/admin/phone?dial=0400000000", "iframe");
    const html = await res.text();
    expect(html).toContain("tcbShowPhone");
    expect(html).not.toContain("new Twilio.Device");
  });

  it("still serves the Phone page itself at the top level", async () => {
    const html = await (await page("/admin/phone", "document")).text();
    expect(html).toContain("new Twilio.Device");
    expect(html).toContain("var INITIAL_SECTION = null;");
  });
});

describe("the frame's /admin/phone stub", () => {
  function runStub(parent: Record<string, unknown> | null) {
    const js = /<script>([\s\S]*?)<\/script>/.exec(renderPhoneFrameStub())?.[1] ?? "";
    const top = { location: { href: "" } };
    const win: Record<string, unknown> = { top };
    win.parent = parent ?? win;
    new Function("window", "location", js)(win, { search: "?listen=CA1" });
    return top;
  }

  it("hands the query to the running Phone page", () => {
    const tcbShowPhone = vi.fn();
    const top = runStub({ tcbShowPhone });
    expect(tcbShowPhone).toHaveBeenCalledWith("?listen=CA1");
    expect(top.location.href).toBe("");
  });

  it("falls back to a plain navigation with no shell above it", () => {
    expect(runStub(null).location.href).toBe("/admin/phone?listen=CA1");
  });
});

describe("the Phone page loaded into a frame anyway", () => {
  // Defence in depth behind the stub: stop before the SDK and the softphone script ever run.
  it("stops loading and hands over to the shell", () => {
    const html = renderPhonePage("phill@b.com");
    const guard = /<script>\s*(if \(window\.top !== window\) \{[\s\S]*?\n {6}\})\s*<\/script>/.exec(html)?.[1];
    if (!guard) throw new Error("could not find the framed-page guard");
    const stop = vi.fn();
    const tcbShowPhone = vi.fn();
    new Function("window", "location", guard)({ top: {}, parent: { tcbShowPhone }, stop }, { search: "?dial=1" });
    expect(stop).toHaveBeenCalled();
    expect(tcbShowPhone).toHaveBeenCalledWith("?dial=1");
    expect(html.indexOf(guard)).toBeLessThan(html.indexOf("twilio.min.js"));
  });
});

// The shell's REAL emitted script, run against a stub DOM.
function shellHarness(section: string | null = null, hash = "") {
  const html = renderPhonePage("phill@b.com", "admin", { section });
  const js = /<script>\s*\/\/ The app shell:[\s\S]*?(\(function \(\) \{[\s\S]*?\n {6}\}\)\(\);)\s*<\/script>/.exec(html)?.[1];
  if (!js) throw new Error("could not find the shell script");

  const frameLoc = { href: "about:blank", pathname: "blank", search: "", hash: "", replace: vi.fn() };
  frameLoc.replace.mockImplementation((u: string) => {
    if (u === "about:blank") Object.assign(frameLoc, { href: u, pathname: "blank", search: "", hash: "" });
    else {
      const url = new URL(u, "https://example.com");
      Object.assign(frameLoc, { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash });
    }
  });
  let onFrameLoad: () => void = () => {};
  const frame = {
    style: {} as Record<string, string>,
    contentWindow: { location: frameLoc },
    addEventListener: (_: string, h: () => void) => (onFrameLoad = h),
  };
  const nav = ["/admin/phone", "/admin/messages"].map((href) => ({
    getAttribute: () => href,
    classList: { toggle: vi.fn() },
  }));
  let clickHandler: (e: unknown) => void = () => {};
  const document = {
    title: "Phone — TCB Phone",
    documentElement: { style: {} as Record<string, string> },
    getElementById: () => frame,
    querySelector: () => ({ offsetHeight: 60 }),
    querySelectorAll: () => nav,
    addEventListener: (_: string, h: (e: unknown) => void) => (clickHandler = h),
  };
  const win: Record<string, unknown> = { addEventListener() {}, tcbPhoneDeepLink: vi.fn() };
  win.top = win;
  const history = { replaceState: vi.fn() };
  const location = { href: "https://example.com/admin/phone", origin: "https://example.com", hash: hash };
  new Function("window", "document", "history", "location", js)(win, document, history, location);

  const click = (href: string) => {
    const e = {
      defaultPrevented: false,
      button: 0,
      target: { closest: () => ({ href: `https://example.com${href}`, target: "", hasAttribute: () => false }) },
      preventDefault: vi.fn(() => (e.defaultPrevented = true)),
    };
    clickHandler(e);
    return e;
  };
  // What the browser does when the frame itself navigates (Back/Forward through its history).
  const frameNavigates = (u: string) => {
    if (u === "about:blank") Object.assign(frameLoc, { href: u, pathname: "blank", search: "", hash: "" });
    else {
      const url = new URL(u, "https://example.com");
      Object.assign(frameLoc, { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash });
    }
    onFrameLoad();
  };
  return { win, frame, frameLoc, history, click, frameNavigates };
}

describe("the shell", () => {
  it("opens a section in the frame instead of navigating away from the softphone", () => {
    const s = shellHarness();
    const e = s.click("/admin/messages");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(s.frame.style.display).toBe("block");
    expect(s.frameLoc.replace).toHaveBeenCalledWith("/admin/messages");
  });

  it("opens the section a refresh or bookmark asked for", () => {
    const s = shellHarness("/admin/voicemail");
    expect(s.frame.style.display).toBe("block");
    expect(s.frameLoc.replace).toHaveBeenCalledWith("/admin/voicemail");
  });

  // The browser never sends the #fragment, so the server cannot put it in INITIAL_SECTION.
  it("keeps the #fragment across a refresh", () => {
    const s = shellHarness("/admin/settings", "#staff");
    expect(s.frameLoc.replace).toHaveBeenCalledWith("/admin/settings#staff");
  });

  // Phone leaves about:blank as the frame's entry; Forward onto it must not cover the softphone.
  it("hides the frame again when Forward lands on the blank entry", () => {
    const s = shellHarness("/admin/messages");
    s.frameNavigates("about:blank");
    expect(s.frame.style.display).toBe("none");
  });

  it("goes back to Phone without a reload, unloading the section", () => {
    const s = shellHarness("/admin/messages");
    s.click("/admin/phone");
    expect(s.frame.style.display).toBe("none");
    expect(s.frameLoc.replace).toHaveBeenLastCalledWith("about:blank");
    expect(s.history.replaceState).toHaveBeenLastCalledWith(null, "", "/admin/phone");
  });

  it("hands a Phone deep link to the running page", () => {
    const s = shellHarness();
    s.click("/admin/phone?dial=0400000000");
    expect(s.win.tcbPhoneDeepLink).toHaveBeenCalledWith("?dial=0400000000");
  });

  // A ringing call hides the section so Answer is on screen. Going back to it must not reload it,
  // or a half-typed text is lost.
  it("keeps a section hidden by a ringing call, and shows it again as it was", () => {
    const s = shellHarness("/admin/messages?to=%2B61400000000");
    (s.win.tcbHideSection as () => void)();
    expect(s.frame.style.display).toBe("none");
    s.frameLoc.replace.mockClear();
    s.click("/admin/messages");
    expect(s.frame.style.display).toBe("block");
    expect(s.frameLoc.replace).not.toHaveBeenCalled();
  });

  // Left hidden after the call, Messages would keep polling its thread and mark every new text read
  // for the whole team with nobody looking.
  it("brings a section back once the call that hid it is over", () => {
    const s = shellHarness("/admin/messages");
    (s.win.tcbHideSection as () => void)();
    (s.win.tcbRestoreSection as () => void)();
    expect(s.frame.style.display).toBe("block");
  });

  it("does not pop a section up after a call that did not hide one", () => {
    const s = shellHarness();
    (s.win.tcbHideSection as () => void)();
    (s.win.tcbRestoreSection as () => void)();
    expect(s.frame.style.display).not.toBe("block");
  });

  // These pages are rendered once on the server, and clicking their link has always refreshed them.
  it("reloads the section on screen when its link is clicked again", () => {
    const s = shellHarness("/admin/live");
    s.frameLoc.replace.mockClear();
    s.click("/admin/live");
    expect(s.frameLoc.replace).toHaveBeenCalledWith("/admin/live");
  });

  // Back after "Call" from Messages moves the hidden frame; showing it keeps Back from looking dead.
  it("shows a hidden frame that Back/Forward navigates", () => {
    const s = shellHarness("/admin/messages");
    s.click("/admin/phone");
    s.frameNavigates("/admin/messages");
    expect(s.frame.style.display).toBe("block");
    expect(s.history.replaceState).toHaveBeenLastCalledWith(null, "", "/admin/messages");
  });
});

describe("a call ending", () => {
  function run(fnName: string) {
    const html = renderPhonePage("phill@b.com");
    const fn = new RegExp(`(function ${fnName}\\([^)]*\\) \\{[\\s\\S]*?\\n {6}\\})`).exec(html)?.[1];
    if (!fn) throw new Error(`could not find ${fnName}`);
    const tcbRestoreSection = vi.fn();
    const el = () => ({ style: {} });
    new Function(
      "window",
      "document",
      `var activeCall = null, isOnHold = false;
       function hideIncomingBanner() {}
       function showDetail() {}
       function setDeviceStatusText() {}
       ${fn}
       try { ${fnName}({}); } catch (e) {}`
    )({ tcbRestoreSection }, { getElementById: el, querySelectorAll: () => [] });
    return tcbRestoreSection;
  }

  it("brings back the section the ring hid, when answered then hung up", () => {
    expect(run("onCallEnded")).toHaveBeenCalled();
  });

  it("brings it back when the ring is missed or declined", () => {
    expect(run("onIncomingGone")).toHaveBeenCalled();
  });
});

describe("a call ringing while a section is open", () => {
  it("brings the Answer banner forward over the section", () => {
    const html = renderPhonePage("phill@b.com");
    const banner = /(function showIncomingBanner\(call\) \{[\s\S]*?\n {6}\})/.exec(html)?.[1];
    if (!banner) throw new Error("could not find showIncomingBanner");
    const tcbHideSection = vi.fn();
    const el = () => ({ style: {}, textContent: "" });
    new Function(
      "window",
      "document",
      `var contactsByNorm = {};
       function normalizePhoneJS(v) { return v; }
       function formatAu(v) { return v; }
       function incomingCallerNumber() { return '+61400000000'; }
       ${banner}
       showIncomingBanner({});`
    )({ tcbHideSection }, { getElementById: el });
    expect(tcbHideSection).toHaveBeenCalled();
  });
});

// Every other admin-only page already sent staff to Phone. /admin/errors answered a bare 403,
// which inside the shell is a blank "forbidden" in the frame under a working header.
describe("a staff member opening App Errors", () => {
  it("is sent to the Phone page like the other admin-only pages", async () => {
    const STAFF = "tech@tcbpestcontrolcanberra.com.au";
    await env.DB.prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)")
      .bind(STAFF)
      .run();
    const res = await worker.fetch(
      new Request("https://example.com/admin/errors", { headers: { "Sec-Fetch-Dest": "document" } }),
      { ...env, DEV_STAFF_EMAIL: STAFF } as never
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/admin/phone");
  });
});

// Every thread load marks it read for the WHOLE team. The REAL emitted poll runs against stubs.
describe("Messages hidden behind a ringing call", () => {
  function poll(hidden: boolean | null) {
    return import("../../src/html/pages/messages").then(({ renderMessagesPage }) => {
      const html = renderMessagesPage("admin");
      const fn = /(function tcbFrameHidden\(\)\{[^\n]*\})/.exec(html)?.[1];
      const line = /(setInterval\(function\(\)\{if\(current&&!tcbFrameHidden\(\)\)loadThread\(\);\},5000\);)/.exec(html)?.[1];
      if (!fn || !line) throw new Error("could not find the thread poll");
      const loadThread = vi.fn();
      let tick: () => void = () => {};
      const frameElement = hidden === null ? null : { style: { display: hidden ? "none" : "block" } };
      new Function("window", "setInterval", "loadThread", `var current = "+61400000000"; ${fn} ${line}`)(
        { frameElement },
        (f: () => void) => (tick = f),
        loadThread
      );
      tick();
      return loadThread;
    });
  }

  it("does not poll the thread while hidden", async () => {
    expect(await poll(true)).not.toHaveBeenCalled();
  });

  it("polls when on screen, framed or not", async () => {
    expect(await poll(false)).toHaveBeenCalled();
    expect(await poll(null)).toHaveBeenCalled();
  });
});

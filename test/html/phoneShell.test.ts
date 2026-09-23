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
    for (const path of ["/admin/calls", "/admin/calls/CA-no-such-call", "/admin/typo", "/admin/ivr/%E0"]) {
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
  const nav = ["/admin/phone", "/admin/messages", "/admin/settings"].map((href) => ({
    getAttribute: () => href,
    classList: { toggle: vi.fn() },
  }));
  let clickHandler: (e: unknown) => void = () => {};
  let pillClick: () => void = () => {};
  const pill = { style: {} as Record<string, string>, addEventListener: (_: string, h: () => void) => (pillClick = h) };
  const media = [{ pause: vi.fn() }];
  (frame as Record<string, unknown>).contentDocument = { querySelectorAll: () => media };
  const document = {
    title: "Phone — TCB Phone",
    documentElement: { style: {} as Record<string, string> },
    getElementById: (id: string) => (id === "back-to-call" ? pill : frame),
    querySelector: () => ({ offsetHeight: 60 }),
    querySelectorAll: () => nav,
    addEventListener: (_: string, h: (e: unknown) => void) => (clickHandler = h),
  };
  let callUp = false;
  const winListeners: Record<string, (e: unknown) => void> = {};
  const win: Record<string, unknown> = {
    addEventListener: (t: string, h: (e: unknown) => void) => (winListeners[t] = h),
    tcbPhoneDeepLink: vi.fn(),
    tcbCallActive: () => callUp,
  };
  win.top = win;
  const history = { replaceState: vi.fn(), pushState: vi.fn() };
  const location = { href: "https://example.com/admin/phone", origin: "https://example.com", hash: hash, pathname: "/admin/phone", search: "" };
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
  const setCallUp = (v: boolean) => (callUp = v);
  const leave = () => {
    const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    winListeners.beforeunload(e);
    return e;
  };
  // What the browser does on Back/Forward: the address changes, then popstate fires.
  const back = (path: string) => {
    const url = new URL(path, "https://example.com");
    Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
    winListeners.popstate({});
  };
  const navActive = () => nav.filter((n) => n.classList.toggle.mock.calls.at(-1)?.[1]).map((n) => n.getAttribute());
  return { win, frame, frameLoc, history, click, frameNavigates, pill, pillClick: () => pillClick(), media, setCallUp, leave, back, navActive };
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
  // The stub hands over and blanks the frame, but its own load event can land first.
  it("does not re-show the frame for the Phone stub's own load", () => {
    const s = shellHarness("/admin/messages");
    s.click("/admin/phone");
    s.frameNavigates("/admin/phone?listen=CA1");
    expect(s.frame.style.display).toBe("none");
  });

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
    expect(s.history.pushState).toHaveBeenLastCalledWith(null, "", "/admin/phone");
  });

  // One history entry per section opened, so Back moves between sections instead of leaving the
  // dashboard (and hanging up a call).
  it("adds a history entry per section, and Back returns to the one before", () => {
    const s = shellHarness();
    s.click("/admin/messages");
    expect(s.history.pushState).toHaveBeenLastCalledWith(null, "", "/admin/messages");
    s.click("/admin/phone");
    s.back("/admin/messages");
    expect(s.frame.style.display).toBe("block");
    expect(s.frameLoc.pathname).toBe("/admin/messages");
    s.back("/admin/phone");
    expect(s.frame.style.display).toBe("none");
  });

  it("marks Settings for the pages reached from it", () => {
    const s = shellHarness();
    s.click("/admin/ivr/main");
    expect(s.navActive()).toEqual(["/admin/settings"]);
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

  it("pauses what a section was playing when a call hides it", () => {
    const s = shellHarness("/admin/voicemail");
    (s.win.tcbHideSection as () => void)();
    expect(s.media[0].pause).toHaveBeenCalled();
  });

  // The parked section holds a draft. Clicking Phone keeps it loaded (going back shows it as it
  // was) but is the user choosing Phone, so it does not pop back when the call ends.
  it("keeps a parked section when Phone is clicked during the call", () => {
    const s = shellHarness("/admin/messages");
    (s.win.tcbHideSection as () => void)();
    s.frameLoc.replace.mockClear();
    s.click("/admin/phone");
    expect(s.frameLoc.replace).not.toHaveBeenCalled();
    (s.win.tcbRestoreSection as () => void)();
    expect(s.frame.style.display).toBe("none");
    s.click("/admin/messages");
    expect(s.frame.style.display).toBe("block");
    expect(s.frameLoc.replace).not.toHaveBeenCalled();
  });

  it("does not bring a section back over a second call still up", () => {
    const s = shellHarness("/admin/messages");
    (s.win.tcbHideSection as () => void)();
    s.setCallUp(true);
    (s.win.tcbRestoreSection as () => void)();
    expect(s.frame.style.display).toBe("none");
  });

  // A Listen or Call that cannot run during a call must not cost the user the page they were on.
  it("leaves the section in place when a Phone link is refused mid-call", () => {
    const s = shellHarness("/admin/live");
    s.setCallUp(true);
    const back = vi.fn();
    (s.frame.contentWindow as Record<string, unknown>).history = { back };
    s.frameNavigates("/admin/phone?listen=CA1");
    (s.win.tcbShowPhone as (q: string) => void)("?listen=CA1");
    expect(s.win.tcbPhoneDeepLink).toHaveBeenCalledWith("?listen=CA1");
    expect(back).toHaveBeenCalled();
    expect(s.frame.style.display).toBe("block");
  });

  // A section opened mid-call covers Hang up / Mute / Hold / Transfer.
  it("offers a way back to the call while a section covers it", () => {
    const s = shellHarness();
    s.setCallUp(true);
    s.click("/admin/messages");
    expect(s.pill.style.display).toBe("block");
    s.pillClick();
    expect(s.frame.style.display).toBe("none");
    expect(s.pill.style.display).toBe("none");
  });

  // The user chose the call; hanging up must not throw the section back over the Phone page.
  it("stays on Phone after a call the user went back to", () => {
    const s = shellHarness();
    s.setCallUp(true);
    s.click("/admin/messages");
    s.pillClick();
    s.setCallUp(false);
    (s.win.tcbRestoreSection as () => void)();
    expect(s.frame.style.display).toBe("none");
  });

  // Back or refresh unloads the page and hangs up the call; the browser must ask first.
  it("asks before leaving the page during a call, and only then", () => {
    const s = shellHarness();
    expect(s.leave().preventDefault).not.toHaveBeenCalled();
    s.setCallUp(true);
    expect(s.leave().preventDefault).toHaveBeenCalled();
    s.win.desktopBridge = {};
    expect(s.leave().preventDefault).not.toHaveBeenCalled();
  });

  it("shows no call button with no call up", () => {
    const s = shellHarness();
    s.click("/admin/messages");
    expect(s.pill.style.display).toBe("none");
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

// Every thread load marks it read for the WHOLE team, and any section's poll may have a side
// effect. The layout pauses every framed section's setInterval while it is hidden, in one place.
describe("a section hidden behind a ringing call", () => {
  async function tickWhile(hidden: boolean | null) {
    const { renderMessagesPage } = await import("../../src/html/pages/messages");
    const html = renderMessagesPage("admin");
    const js = /<title>[^<]*<\/title>\s*<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!js) throw new Error("could not find the layout head script");
    let tick: () => void = () => {};
    const frameElement = hidden === null ? null : { style: { display: hidden ? "none" : "block" } };
    const win: Record<string, unknown> = { frameElement, setInterval: (f: () => void) => (tick = f) };
    win.top = hidden === null ? win : {};
    new Function("window", "document", "location", js)(win, { documentElement: { className: "" } }, { replace() {} });
    const poll = vi.fn();
    (win.setInterval as (f: () => void, ms: number) => void)(poll, 5000);
    tick();
    return poll;
  }

  it("does not run its polls while hidden", async () => {
    expect(await tickWhile(true)).not.toHaveBeenCalled();
  });

  it("runs them when on screen, framed or not", async () => {
    expect(await tickWhile(false)).toHaveBeenCalled();
    expect(await tickWhile(null)).toHaveBeenCalled();
  });
});

// A browser that sends no Sec-Fetch-Dest gets the plain page even at the top level -- no softphone.
// The page sends itself into the shell.
describe("a section loaded as the whole window without the shell", () => {
  function runHead(html: string, top: boolean) {
    const js = /<title>[^<]*<\/title>\s*<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!js) throw new Error("could not find the layout head script");
    const replace = vi.fn();
    const win: Record<string, unknown> = {};
    win.top = top ? win : {};
    new Function("window", "document", "location", js)(
      win,
      { documentElement: { className: "" } },
      { pathname: "/admin/messages", search: "?to=1", hash: "", replace }
    );
    return replace;
  }

  it("sends itself into the shell with that section open", async () => {
    const { renderMessagesPage } = await import("../../src/html/pages/messages");
    expect(runHead(renderMessagesPage("admin"), true)).toHaveBeenCalledWith(
      "/admin/phone?section=" + encodeURIComponent("/admin/messages?to=1")
    );
  });

  it("stays put inside the frame, and the Phone page never redirects itself", async () => {
    const { renderMessagesPage } = await import("../../src/html/pages/messages");
    expect(runHead(renderMessagesPage("admin"), false)).not.toHaveBeenCalled();
    expect(runHead(renderPhonePage("phill@b.com"), true)).not.toHaveBeenCalled();
  });

  it("is served the shell with that section by /admin/phone?section=", async () => {
    const html = await (await page("/admin/phone?section=" + encodeURIComponent("/admin/voicemail"), "document")).text();
    expect(html).toContain('var INITIAL_SECTION = "/admin/voicemail";');
  });

  it("never opens another site, or Phone itself, in the frame", async () => {
    for (const bad of ["https://evil.example/", "//evil.example/admin/x", "/admin/phone", "/admin/phone?dial=1", "/login"]) {
      const html = await (await page("/admin/phone?section=" + encodeURIComponent(bad), "document")).text();
      expect(html, bad).toContain("var INITIAL_SECTION = null;");
    }
  });
});

// Every dashboard tab is the Phone page now; without the lock a second tab rings every call too.
describe("more than one dashboard tab", () => {
  function boot(locks: unknown) {
    const html = renderPhonePage("phill@b.com");
    const js = /(if \(window\.Twilio\) \{[\s\S]*?\n {6}\})/.exec(html)?.[1];
    if (!js) throw new Error("could not find the softphone start-up");
    const initDevice = vi.fn();
    new Function("window", "navigator", "initDevice", "setDeviceStatusText", "document", "deviceFailed", js)(
      { Twilio: {} },
      { locks },
      initDevice,
      () => {},
      { getElementById: () => ({ style: {} }) },
      false
    );
    return initDevice;
  }

  it("starts the softphone only once this tab holds the lock", () => {
    let grant: () => void = () => {};
    const initDevice = boot({ request: (_: string, f: () => void) => (grant = f) });
    expect(initDevice).not.toHaveBeenCalled();
    grant();
    expect(initDevice).toHaveBeenCalled();
  });

  it("starts it straight away in a browser without locks", () => {
    expect(boot(undefined)).toHaveBeenCalled();
  });
});

describe("a call-detail page loaded at the top level", () => {
  it("gets the shell for a call that exists, without rendering the page twice", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO calls (id, caller_number, called_number, started_at, status) VALUES ('CA-shell-exists', '+61400000000', '+61261059771', 1, 'completed')"
    ).run();
    const html = await (await page("/admin/calls/CA-shell-exists", "document")).text();
    expect(html).toContain('var INITIAL_SECTION = "/admin/calls/CA-shell-exists";');
  });
});

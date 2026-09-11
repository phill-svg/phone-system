import { leaveAdmin, SETTINGS_HREF } from "../src/lib/nav";
import { ADMIN_SCREENS } from "../src/app/admin/_layout";

function fakeRouter(canGoBack: boolean) {
  const calls: string[] = [];
  return {
    calls,
    canGoBack: () => canGoBack,
    back: () => calls.push("back"),
    replace: (href: string) => calls.push(`replace:${href}`),
  };
}

describe("leaveAdmin", () => {
  // The normal route in: Settings → Administration. Popping keeps the Settings tab's own scroll
  // position and history, which a replace would throw away.
  it("pops when there is somewhere to pop to", () => {
    const r = fakeRouter(true);
    leaveAdmin(r);
    expect(r.calls).toEqual(["back"]);
  });

  // A cold start or a deep link straight to /admin leaves an empty history. back() there is a
  // no-op, and a back button that visibly does nothing is a worse bug than the missing button --
  // it reads as the app having frozen.
  it("goes to Settings when the history is empty, rather than doing nothing", () => {
    const r = fakeRouter(false);
    leaveAdmin(r);
    expect(r.calls).toEqual([`replace:${SETTINGS_HREF}`]);
  });
});

// leaveAdmin's rule was tested from the start, but nothing pinned the thing that CALLS it. Delete
// the `headerLeft` from admin/_layout.tsx and every test above still passes while the Admin hub is
// stranded again exactly as reported -- no tab bar (the `admin` group is a sibling of `(tabs)`) and
// no automatic chevron (`index` is the root of that nested stack). This file gets rewritten
// whenever a screen is added, which is when that would happen.
describe("the Admin hub's way out", () => {
  it("gives the hub screen its own back button", () => {
    const hub = ADMIN_SCREENS.find((s) => s.name === "index");
    expect(hub).toBeDefined();
    expect(typeof hub!.options.headerLeft).toBe("function");
  });

  // The sub-screens are pushed INSIDE that stack, so React Navigation draws the chevron for them.
  // A headerLeft here would replace it with a button that says "Settings" on a screen whose back
  // destination is the hub.
  it("leaves the pushed sub-screens to the navigator's own chevron", () => {
    for (const screen of ADMIN_SCREENS.filter((s) => s.name !== "index")) {
      expect(screen.options.headerLeft).toBeUndefined();
    }
  });

  it("registers every screen exactly once", () => {
    const names = ADMIN_SCREENS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

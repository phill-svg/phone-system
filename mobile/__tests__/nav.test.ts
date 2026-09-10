import { leaveAdmin, SETTINGS_HREF } from "../src/lib/nav";

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

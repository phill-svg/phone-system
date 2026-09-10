import { weekLabel, shortName } from "../src/lib/onCall";

describe("weekLabel", () => {
  it("renders the Monday-to-Sunday span", () => {
    expect(weekLabel("2026-09-07")).toBe("7 Sep – 13 Sep");
  });

  it("spans a month boundary", () => {
    expect(weekLabel("2026-09-28")).toBe("28 Sep – 4 Oct");
  });

  // The key is a Canberra calendar date the server already decided. Reading it through the device's
  // LOCAL parts shifts it a day for any handset west of Sydney -- a phone left on a US timezone
  // shows the rota a day out while the server rings the right person, which is the worst kind of
  // wrong: it looks like the rota is broken when it is not.
  //
  // Asserting this by setting process.env.TZ does NOT work and is worth remembering: Node caches the
  // zone, so the value assertions above pass identically against local getters whenever the suite
  // itself runs in UTC -- which is the default here and in CI. That version of this test passed with
  // the fix fully reverted. The invariant is "never reads local parts", so that is what is pinned.
  it("never reads the date through the device's local timezone", () => {
    const localGetters = ["getDate", "getMonth", "getFullYear", "getDay"] as const;
    const spies = localGetters.map((name) => jest.spyOn(Date.prototype, name));
    try {
      weekLabel("2026-09-07");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("shortName", () => {
  it("drops the domain so a rota row stays readable on a phone", () => {
    expect(shortName("phill@tcbpestcontrolcanberra.com.au")).toBe("phill");
  });
});

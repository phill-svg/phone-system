import { weekLabel, shortName, rotationMemberFor } from "../src/lib/onCall";

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

describe("rotationMemberFor", () => {
  const MEMBERS = ["a@x.com", "b@x.com", "c@x.com"];
  const ANCHOR = "2026-09-07";

  it("advances one person per week and wraps", () => {
    expect(rotationMemberFor(MEMBERS, ANCHOR, "2026-09-07")).toBe("a@x.com");
    expect(rotationMemberFor(MEMBERS, ANCHOR, "2026-09-28")).toBe("a@x.com");
    expect(rotationMemberFor(MEMBERS, ANCHOR, "2026-09-14")).toBe("b@x.com");
  });

  it("resolves weeks before the anchor rather than returning nothing", () => {
    expect(rotationMemberFor(MEMBERS, ANCHOR, "2026-08-31")).toBe("c@x.com");
  });

  // The whole reason this exists on the client. Preserving the anchor is not enough -- the member
  // COUNT re-indexes every week, so adding a fourth tech silently moves tonight's on-call person.
  // The screen compares before/after with this and asks first.
  it("shows that adding a member reassigns the current week", () => {
    const week = "2026-10-05"; // elapsed 4
    expect(rotationMemberFor(MEMBERS, ANCHOR, week)).toBe("b@x.com");
    expect(rotationMemberFor([...MEMBERS, "d@x.com"], ANCHOR, week)).toBe("a@x.com");
  });

  it("is nobody with no members or no anchor", () => {
    expect(rotationMemberFor([], ANCHOR, "2026-09-07")).toBeNull();
    expect(rotationMemberFor(MEMBERS, "", "2026-09-07")).toBeNull();
  });
});

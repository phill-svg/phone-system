import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain CommonJS, deliberately outside the worker's TS build
import { notesToShow, RELEASE_NOTES } from "../../desktop/releaseNotes.js";

// Auto-update polls every six hours and a desk can be off for a week, so a machine routinely
// jumps several versions at once. Showing only the current version's notes would silently drop
// everything in between -- which is most of what anyone would want to read.
const NOTES = { "1.2.1": ["one"], "1.2.2": ["two"], "1.3.0": ["three"], "1.10.0": ["ten"] };

describe("what a launch announces", () => {
  it("covers every version skipped over, not just the one now running", () => {
    expect(notesToShow("1.2.0", "1.3.0", NOTES)).toEqual(["one", "two", "three"]);
  });

  it("says nothing on a fresh install, which has no previous version", () => {
    expect(notesToShow(null, "1.3.0", NOTES)).toEqual([]);
  });

  it("says nothing when the version has not moved", () => {
    expect(notesToShow("1.3.0", "1.3.0", NOTES)).toEqual([]);
  });

  it("orders by number, so 1.10.0 lands after 1.3.0", () => {
    expect(notesToShow("1.2.2", "1.10.0", NOTES)).toEqual(["three", "ten"]);
  });

  it("shows nothing for a release with no entry", () => {
    expect(notesToShow("1.2.2", "1.2.3", NOTES)).toEqual([]);
  });

  it("has an entry for the version being shipped", () => {
    expect(RELEASE_NOTES["1.2.2"]?.length).toBeGreaterThan(0);
  });
});

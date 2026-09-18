import { describe, expect, it } from "vitest";
import { clientDialTarget } from "../../src/twilio/clientTarget";

describe("clientDialTarget", () => {
  it("sends the saved contact name to read, and the number to act on", () => {
    expect(clientDialTarget("phill@b.com", { number: "+61421022938", name: "Jane Customer" })).toBe(
      "client:phill@b.com?CallerNumber=61421022938&CallerName=Jane%20Customer"
    );
  });

  // iOS substitutes ${CallerName} into its CallKit banner natively; a leg without the key renders
  // the template literally on the lock screen.
  it("falls back to the number for the name, so the native template always resolves", () => {
    expect(clientDialTarget("phill@b.com", { number: "+61421022938", name: null })).toBe(
      "client:phill@b.com?CallerNumber=61421022938&CallerName=61421022938"
    );
  });

  it("treats a blank contact name as no name", () => {
    expect(clientDialTarget("phill@b.com", { number: "+61421022938", name: "   " })).toBe(
      "client:phill@b.com?CallerNumber=61421022938&CallerName=61421022938"
    );
  });

  // A withheld caller: better a bare identity than a parameter asserting something we do not know.
  it("sends no caller parameters at all when the caller is unknown", () => {
    expect(clientDialTarget("phill@b.com", { number: null, name: null })).toBe("client:phill@b.com");
  });
});

/// <reference types="jest" />

jest.mock("../src/lib/api");
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

import { Alert } from "react-native";
import { router } from "expo-router";
import { callViaMobile } from "../src/lib/api";
import { placeCall, resetDialGuard } from "../src/lib/placeCall";
import type { UserSettings } from "../src/lib/api";

const VIA_MOBILE = { call_via_mobile: true, mobile_number: "0412345678" } as unknown as UserSettings;
const VIA_VOIP = { call_via_mobile: false, mobile_number: "" } as unknown as UserSettings;

describe("placeCall duplicate guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Spy rather than jest.mock("react-native"): replacing the whole module strips Platform, which
    // expo-modules-core dereferences at import time, and the suite dies before any test runs.
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
    resetDialGuard();
    (callViaMobile as jest.Mock).mockResolvedValue({ callSid: "CA1", ringing: "+61412345678" });
  });

  // Reported as "the dial from mobile worked but it rang my mobile twice": the calls table held two
  // outbound legs to the same customer two seconds apart. Nothing retries -- the app sent the
  // request twice, because the only feedback is an Alert that appears AFTER the round trip, so the
  // first tap looks like it did nothing.
  it("places one call when the button is tapped twice", async () => {
    await placeCall({ number: "0421022938", settings: VIA_MOBILE });
    await placeCall({ number: "0421022938", settings: VIA_MOBILE });
    expect(callViaMobile).toHaveBeenCalledTimes(1);
  });

  // The guard is per-number: ringing someone else straight after must still work.
  it("does not block a call to a different number", async () => {
    await placeCall({ number: "0421022938", settings: VIA_MOBILE });
    await placeCall({ number: "0400000000", settings: VIA_MOBILE });
    expect(callViaMobile).toHaveBeenCalledTimes(2);
  });

  // The VoIP path stacks a second in-call screen on a double tap, which is the same bug wearing a
  // different hat -- the guard sits above the branch so it covers both.
  it("pushes one in-call screen when the VoIP path is tapped twice", async () => {
    await placeCall({ number: "0421022938", settings: VIA_VOIP });
    await placeCall({ number: "0421022938", settings: VIA_VOIP });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  // It must be a WINDOW, not a latch: a call that failed has to be re-dialable, and a guard that
  // never released would leave the number permanently un-callable.
  it("allows the same number again once the window has passed", async () => {
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      await placeCall({ number: "0421022938", settings: VIA_MOBILE });
      t += 6000;
      await placeCall({ number: "0421022938", settings: VIA_MOBILE });
      expect(callViaMobile).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });
});

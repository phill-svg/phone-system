/**
 * The 0xBAADCA11 crash of 2026-09-10.
 *
 * A VoIP push wakes the app in the BACKGROUND and iOS allows roughly five seconds to report the
 * call to CallKit; miss it and FrontBoard SIGKILLs the process ("bad call"). The device log shows
 * exactly that: procRole "Non UI", phone locked, launched 11:38:11 and killed 11:38:18.
 *
 * initializePushRegistry() used to run inside registerForIncoming -- behind the JS bundle booting,
 * auth resolving, the tabs mounting, a permission check, and with a network round trip after it.
 * These tests pin the BEHAVIOUR of the fix, not the shape of the source: an earlier version of this
 * file matched text with indexOf and passed with the fix fully reverted into a useEffect, because
 * the comment above it mentioned the call.
 */
import { Platform } from "react-native";

const mockRegistry = { calls: 0, fail: null as string | null };

jest.mock("@twilio/voice-react-native-sdk", () => {
  class FakeVoice {
    on() { return this; }
    off() { return this; }
    async initializePushRegistry() {
      mockRegistry.calls += 1;
      if (mockRegistry.fail) throw new Error(mockRegistry.fail);
    }
    async register() {}
  }
  const Voice: any = jest.fn().mockImplementation(() => new FakeVoice());
  Voice.Event = { CallInvite: "callInvite", Registered: "registered", Error: "error" };
  const Call: any = {};
  Call.Event = { Disconnected: "disconnected", ConnectFailure: "connectFailure" };
  Call.State = {};
  const CallInvite: any = {};
  CallInvite.Event = { Accepted: "accepted", Rejected: "rejected", Cancelled: "cancelled" };
  CallInvite.State = { Pending: "pending" };
  return { Voice, Call, CallInvite, PreflightTest: {} };
});

// A FRESH copy of the module per test. primePushRegistry deliberately keeps its state at module
// scope -- that is what makes it idempotent across the whole app run -- so without this the first
// test's successful prime makes every later one a no-op.
function freshVoice() {
  let mod!: typeof import("../src/lib/voice");
  jest.isolateModules(() => {
    mod = require("../src/lib/voice");
  });
  return mod;
}

describe("PushKit registry priming", () => {
  beforeEach(() => {
    mockRegistry.calls = 0;
    mockRegistry.fail = null;
    Platform.OS = "ios";
  });

  it("creates the registry exactly once when primed repeatedly", async () => {
    const { primePushRegistry } = freshVoice();
    await primePushRegistry();
    await primePushRegistry();
    await primePushRegistry();
    expect(mockRegistry.calls).toBe(1);
  });

  // It runs at app startup, where a throw would stop the app opening at all -- and the app failing
  // to launch is strictly worse than incoming calls not arriving.
  it("never rejects, even when the native call fails", async () => {
    const { primePushRegistry, getPushRegistryError } = freshVoice();
    mockRegistry.fail = "no pushkit for you";
    await expect(primePushRegistry()).resolves.toBeUndefined();
    expect(getPushRegistryError()).toBe("no pushkit for you");
  });

  // A rejection must NOT be memoised as a resolved promise. That would leave the handset silently
  // taking no incoming calls until it was force quit -- worse than the crash being fixed, because
  // the old code rebuilt the registry on every registerForIncoming and so recovered by itself.
  it("retries after a failure instead of caching it as success", async () => {
    const { primePushRegistry, getPushRegistryError } = freshVoice();
    mockRegistry.fail = "transient";
    await primePushRegistry();
    expect(mockRegistry.calls).toBe(1);

    mockRegistry.fail = null;
    await primePushRegistry();
    expect(mockRegistry.calls).toBe(2);
    expect(getPushRegistryError()).toBeNull();
  });

  // Android uses FCM; the native call does not exist there and throws if invoked.
  it("does nothing at all on Android", async () => {
    Platform.OS = "android";
    const { primePushRegistry } = freshVoice();
    await primePushRegistry();
    expect(mockRegistry.calls).toBe(0);
  });
});

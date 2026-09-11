/**
 * A handset that is logged out must stop ringing for customer calls.
 *
 * Registration is a binding TWILIO holds, not a local flag, and nothing in this app ever undid it:
 * `unregister` appeared nowhere in the codebase, and the cleanup returned by registerForIncoming
 * only removed local JS listeners. So a phone stayed registered forever -- observed on 2026-09-11
 * as an Android handset that was logged out and rang anyway, for a real customer.
 *
 * The same gap means a REMOVED staff member's phone keeps ringing and can still ANSWER a live
 * customer call. It cannot be fixed server-side: unregistering is a client-side SDK call, so it has
 * to happen while the user still holds a session -- which is why signOut awaits this BEFORE
 * clearing the token.
 */
import { Platform } from "react-native";

const mockVoiceRef: { current: any } = { current: null };

jest.mock("@twilio/voice-react-native-sdk", () => {
  class FakeVoice {
    unregisterCalls: string[] = [];
    unregisterImpl: (t: string) => Promise<void> = async () => {};
    on() { return this; }
    off() { return this; }
    async initializePushRegistry() {}
    async register() {}
    async unregister(token: string) {
      this.unregisterCalls.push(token);
      return this.unregisterImpl(token);
    }
    async getCallInvites() { return new Map(); }
  }
  const Voice: any = jest.fn().mockImplementation(() => {
    mockVoiceRef.current = new FakeVoice();
    return mockVoiceRef.current;
  });
  Voice.Event = { CallInvite: "callInvite", Registered: "registered", Error: "error" };
  const Call: any = {};
  Call.Event = { Disconnected: "disconnected", ConnectFailure: "connectFailure" };
  Call.State = { Connected: "connected", Disconnected: "disconnected" };
  const CallInvite: any = {};
  CallInvite.State = { Pending: "pending" };
  CallInvite.Event = { Accepted: "accepted", Rejected: "rejected", Cancelled: "cancelled" };
  return { Voice, Call, CallInvite, PreflightTest: { Event: {} } };
});

const mockGetToken = jest.fn();
jest.mock("../src/lib/api", () => ({ getSoftphoneToken: (...a: unknown[]) => mockGetToken(...a) }));
jest.mock("../src/lib/prefs", () => ({ getPref: jest.fn().mockResolvedValue("automatic"), getPrefBool: jest.fn().mockResolvedValue(false) }));
jest.mock("../src/lib/audioRouting", () => ({ chooseAudioDevice: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const voiceLib = require("../src/lib/voice");

describe("unregisterFromIncoming", () => {
  beforeEach(() => {
    mockGetToken.mockReset().mockResolvedValue("tok-abc");
    if (mockVoiceRef.current) {
      mockVoiceRef.current.unregisterCalls = [];
      mockVoiceRef.current.unregisterImpl = async () => {};
    }
  });

  it("hands Twilio the access token, which is what actually stops the ringing", async () => {
    await expect(voiceLib.unregisterFromIncoming()).resolves.toBe(true);
    expect(mockVoiceRef.current.unregisterCalls).toEqual(["tok-abc"]);
  });

  // The deadline must not outlive the race it bounds. Left uncleared it holds a timer open for five
  // seconds after EVERY sign-out -- which in Jest is an open handle that force-exits the worker,
  // and is how it was found. Asserted on the path where the unregister WINS: on the timeout path
  // the timer has fired and is gone whether or not anything cleared it, so that proves nothing.
  it("clears its deadline once the unregister lands", async () => {
    jest.useFakeTimers();
    try {
      await expect(voiceLib.unregisterFromIncoming()).resolves.toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("asks for a token for THIS platform, since the two use different push credentials", async () => {
    await voiceLib.unregisterFromIncoming();
    expect(mockGetToken).toHaveBeenCalledWith(Platform.OS === "ios" ? "ios" : "android");
  });

  // apiFetch has no timeout. Without a deadline an unsettled token request would hang sign-out
  // forever and trap someone in the app they are trying to leave -- the same permanent wedge
  // already recorded for placeCall. Logging out must always complete.
  it("gives up rather than hanging sign-out when the request never settles", async () => {
    // Fake timers, not five real seconds of wall clock: on real ones this single case was the
    // slowest suite in the mobile project, longer than the other 28 put together.
    jest.useFakeTimers();
    try {
      mockGetToken.mockReturnValue(new Promise(() => {}));
      const pending = voiceLib.unregisterFromIncoming();
      // Let the awaits ahead of the deadline settle so the timer actually exists before it is
      // advanced past -- advancing an empty queue would hang the test rather than fail it.
      for (let i = 0; i < 20 && jest.getTimerCount() === 0; i++) await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(5000);
      await expect(pending).resolves.toBe(false);
      // It resolved at all, which is the whole point -- the request it was waiting on never does.
      expect(mockVoiceRef.current.unregisterCalls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports failure rather than throwing, so sign-out still completes", async () => {
    mockVoiceRef.current.unregisterImpl = async () => { throw new Error("network down"); };
    await expect(voiceLib.unregisterFromIncoming()).resolves.toBe(false);
  });

  it("survives the token request being rejected", async () => {
    mockGetToken.mockRejectedValue(new Error("401 unauthorized"));
    await expect(voiceLib.unregisterFromIncoming()).resolves.toBe(false);
    expect(mockVoiceRef.current.unregisterCalls).toEqual([]);
  });
});

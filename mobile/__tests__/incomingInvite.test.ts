/**
 * Regression guard for the crash that killed the app on 2026-09-04 at 09:14.
 *
 * Accepting a CallInvite that is no longer `pending` throws inside TwilioVoice's native CallKit
 * path as an Objective-C exception, which no JS try/catch can reach -- the process aborts. The
 * window is easy to hit: the caller hangs up while our ringing screen is still up, and either
 * auto-answer's timer or CallKit's own Answer button fires into the dead invite.
 *
 * These tests pin the two guards that close it: a cancelled invite is dropped, and a non-pending
 * invite is never accepted or rejected.
 */
import { Platform } from "react-native";

const CallInviteState = { Pending: "pending", Accepted: "accepted", Rejected: "rejected" };
const CallInviteEvent = { Accepted: "accepted", Rejected: "rejected", Cancelled: "cancelled" };

// jest.mock factories are hoisted and may only close over `mock`-prefixed names.
const mockVoiceRef: { current: any } = { current: null };

jest.mock("@twilio/voice-react-native-sdk", () => {
  class FakeVoice {
    handlers: Record<string, ((...a: any[]) => void)[]> = {};
    on(e: string, fn: (...a: any[]) => void) {
      if (!this.handlers[e]) this.handlers[e] = [];
      this.handlers[e].push(fn);
      return this;
    }
    off(e: string, fn: (...a: any[]) => void) {
      this.handlers[e] = (this.handlers[e] || []).filter((f) => f !== fn);
      return this;
    }
    emit(e: string, ...a: any[]) {
      (this.handlers[e] || []).forEach((f) => f(...a));
    }
    async initializePushRegistry() {}
    async register() {}
  }
  const Voice: any = jest.fn().mockImplementation(() => {
    mockVoiceRef.current = new FakeVoice();
    return mockVoiceRef.current;
  });
  Voice.Event = { CallInvite: "callInvite", Registered: "registered", Error: "error" };
  const Call: any = {};
  Call.Event = { Disconnected: "disconnected", ConnectFailure: "connectFailure" };
  const CallInvite: any = {};
  CallInvite.State = { Pending: "pending", Accepted: "accepted", Rejected: "rejected" };
  CallInvite.Event = { Accepted: "accepted", Rejected: "rejected", Cancelled: "cancelled" };
  return { Voice, Call, CallInvite, PreflightTest: { Event: {} } };
});

jest.mock("../src/lib/api", () => ({ getSoftphoneToken: jest.fn().mockResolvedValue("tok") }));
jest.mock("../src/lib/prefs", () => ({ getPref: jest.fn().mockResolvedValue("automatic"), getPrefBool: jest.fn().mockResolvedValue(false) }));
jest.mock("../src/lib/audioRouting", () => ({ chooseAudioDevice: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const voiceLib = require("../src/lib/voice");

function makeInvite(state: string) {
  const listeners: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    state,
    accepted: false,
    rejected: false,
    getFrom: () => "+61400000000",
    getState() { return this.state; },
    on(e: string, fn: (...a: any[]) => void) { (listeners[e] ||= []).push(fn); return this; },
    fire(e: string) { (listeners[e] || []).forEach((f) => f()); },
    fireWith(e: string, arg: any) { (listeners[e] || []).forEach((f) => f(arg)); },
    async accept() { this.accepted = true; return { on: jest.fn() }; },
    async reject() { this.rejected = true; },
  };
}

describe("incoming invite lifecycle", () => {
  beforeEach(() => { Platform.OS = "android"; });

  it("a cancelled invite is dropped, so a later accept cannot reach the native layer", async () => {
    const unsub = await voiceLib.registerForIncoming(() => {});
    const invite = makeInvite(CallInviteState.Pending);

    mockVoiceRef.current.emit("callInvite", invite);
    expect(voiceLib.getPendingInvite()).toBe(invite);

    // Caller hangs up -> SDK cancels the invite.
    invite.state = CallInviteState.Rejected;
    invite.fire(CallInviteEvent.Cancelled);

    expect(voiceLib.getPendingInvite()).toBeNull();
    await expect(voiceLib.acceptIncoming()).resolves.toBeNull();
    expect(invite.accepted).toBe(false);
    unsub();
  });

  it("never accepts an invite that is no longer pending, even if it is still the pending one", async () => {
    const unsub = await voiceLib.registerForIncoming(() => {});
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    // CallKit answered it natively; our JS then races in behind it.
    invite.state = CallInviteState.Accepted;

    await expect(voiceLib.acceptIncoming()).resolves.toBeNull();
    expect(invite.accepted).toBe(false);
    unsub();
  });

  it("never rejects an invite that is no longer pending", async () => {
    const unsub = await voiceLib.registerForIncoming(() => {});
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    invite.state = CallInviteState.Accepted;
    await voiceLib.rejectIncoming();
    expect(invite.rejected).toBe(false);
    unsub();
  });

  it("notifies subscribers on cancellation so the ringing screen can dismiss", async () => {
    const unsub = await voiceLib.registerForIncoming(() => {});
    const seen = jest.fn();
    const off = voiceLib.onInviteCancelled(seen);

    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);
    invite.fire(CallInviteEvent.Cancelled);

    expect(seen).toHaveBeenCalledTimes(1);
    off();
    unsub();
  });

  // The screenshot case: the call was answered from CallKit's own lock-screen UI, so our JS never
  // ran. Nothing dismissed the ringing screen, it stayed up mid-conversation with a live Accept
  // button, and tapping it accepted an already-accepted invite -- which aborts the app.
  it("adopts an invite answered natively, drops it, and notifies so the ringing screen moves on", async () => {
    const unsub = await voiceLib.registerForIncoming(() => {});
    const seen = jest.fn();
    const off = voiceLib.onInviteAccepted(seen);

    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    // CallKit answers it; the SDK raises Accepted with the resulting Call.
    invite.state = CallInviteState.Accepted;
    (invite as any).fireWith(CallInviteEvent.Accepted, { on: jest.fn() });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(voiceLib.getPendingInvite()).toBeNull();
    // And a later tap on the stale Accept button cannot reach the native layer.
    await expect(voiceLib.acceptIncoming()).resolves.toBeNull();
    expect(invite.accepted).toBe(false);
    off();
    unsub();
  });

  it("still accepts a genuinely pending invite", async () => {
    const unsub = await voiceLib.registerForIncoming(() => {});
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    await expect(voiceLib.acceptIncoming()).resolves.not.toBeNull();
    expect(invite.accepted).toBe(true);
    unsub();
  });
});

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
  Call.State = { Connected: "connected", Connecting: "connecting", Disconnected: "disconnected" };
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
  const cleanups: (() => void)[] = [];
  const track = <T extends () => void>(fn: T): T => { cleanups.push(fn); return fn; };

  beforeEach(() => { Platform.OS = "android"; });
  // The module holds ONE Voice instance, so a test that fails before its own unsub would leak a
  // listener and cascade into every later test. Always tear down.
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    // `activeCall` is module state; without this a call adopted by one test leaks into the next.
    voiceLib.setActiveCall(null);
  });

  it("a cancelled invite is dropped, so a later accept cannot reach the native layer", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
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

  // Answered natively, then our JS races in behind it. We must NOT call accept() again (that aborts
  // the app), but we must still hand back the live call: returning null here made the ringing screen
  // treat a connected call as a failed answer and pop itself off an empty stack -- a black screen
  // in front of a call that was actually up.
  it("does not re-accept a natively-accepted invite, but returns the live call so the UI can follow", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    const nativeCall = { on: jest.fn(), getState: () => "connected" };
    invite.state = CallInviteState.Accepted;
    (invite as any).fireWith(CallInviteEvent.Accepted, nativeCall);

    await expect(voiceLib.acceptIncoming()).resolves.toBe(nativeCall);
    expect(invite.accepted).toBe(false);
    unsub();
  });

  // A withdrawn invite has no call behind it, so null is still the right answer there.
  it("returns null for a cancelled invite, since there is no call to show", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    invite.state = CallInviteState.Rejected;
    invite.fire(CallInviteEvent.Cancelled);

    await expect(voiceLib.acceptIncoming()).resolves.toBeNull();
    expect(invite.accepted).toBe(false);
    unsub();
  });

  it("never rejects an invite that is no longer pending", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    invite.state = CallInviteState.Accepted;
    await voiceLib.rejectIncoming();
    expect(invite.rejected).toBe(false);
    unsub();
  });

  it("notifies subscribers on cancellation so the ringing screen can dismiss", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const seen = jest.fn();
    const off = track(voiceLib.onInviteCancelled(seen));

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
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const seen = jest.fn();
    const off = track(voiceLib.onInviteAccepted(seen));

    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    // CallKit answers it; the SDK raises Accepted with the resulting Call.
    invite.state = CallInviteState.Accepted;
    (invite as any).fireWith(CallInviteEvent.Accepted, { on: jest.fn(), getState: () => "connected" });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(voiceLib.getPendingInvite()).toBeNull();
    // A later tap on the stale Accept button must not reach the native layer (that aborts the app),
    // but must still hand back the live call so the UI follows it rather than dead-ending on black.
    await expect(voiceLib.acceptIncoming()).resolves.not.toBeNull();
    expect(invite.accepted).toBe(false);
    off();
    unsub();
  });

  it("still accepts a genuinely pending invite", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    await expect(voiceLib.acceptIncoming()).resolves.not.toBeNull();
    expect(invite.accepted).toBe(true);
    unsub();
  });
});

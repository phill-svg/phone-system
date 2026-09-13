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
    pendingInvites = new Map<string, any>();
    async getCallInvites() {
      return this.pendingInvites;
    }
    calls = new Map<string, any>();
    async getCalls() {
      return this.calls;
    }
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

  // Signing out while the phone is RINGING has to stop it. Unregistering alone does not: the invite
  // is already delivered and CallKit's own UI is already up, so without this the caller sits behind
  // a leg nobody is going to answer for the whole ring window instead of falling through.
  it("rejects a ringing invite when the handset unregisters on sign-out", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);
    expect(voiceLib.getPendingInvite()).toBe(invite);

    // The fake Voice has no `unregister`, so the Twilio half fails -- which is the point: the
    // invite must be dealt with regardless of whether the unregister itself lands.
    await expect(voiceLib.unregisterFromIncoming()).resolves.toBe(false);

    expect(invite.rejected).toBe(true);
    expect(voiceLib.getPendingInvite()).toBeNull();
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

  // The native module is built during launch now, so a cold launch from a VoIP push can ring and
  // even be answered from CallKit before JS subscribes -- and the SDK does not re-emit an event
  // nobody was listening for. Without this replay the app holds no invite for a call that is
  // audibly ringing in the user's hand.
  it("adopts an invite the native layer was already holding before JS subscribed", async () => {
    const invite = makeInvite(CallInviteState.Pending);
    const onInvite = jest.fn();

    // Seeded BEFORE registering, which is the whole point: it arrived while JS was still booting.
    mockVoiceRef.current.pendingInvites = new Map([["uuid-1", invite]]);
    const unsub = track(await voiceLib.registerForIncoming(onInvite));
    await new Promise((r) => setImmediate(r));

    expect(voiceLib.getPendingInvite()).toBe(invite);
    expect(onInvite).toHaveBeenCalledWith("+61400000000");
    unsub();
  });

  // The replay's own target case: answered from the CallKit screen before JS subscribed. On iOS the
  // SDK keeps that invite in getCallInvites() -- rebuilt as Pending -- until the call ends, so the
  // replay announced a LIVE call as ringing, every Pending guard passed, and Decline hung up on the
  // customer. The answered call is in getCalls() under the same uuid; adopt it instead.
  it("adopts a call already answered from the lock screen instead of ringing for it again", async () => {
    // Clear module state an earlier test left behind (an un-cancelled pending invite).
    mockVoiceRef.current.pendingInvites = new Map();
    const clear = await voiceLib.registerForIncoming(() => {});
    const stale = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", stale);
    stale.fire(CallInviteEvent.Cancelled);
    clear();

    const invite = makeInvite(CallInviteState.Pending);
    const call = { on: jest.fn() };
    const onInvite = jest.fn();
    mockVoiceRef.current.pendingInvites = new Map([["uuid-2", invite]]);
    mockVoiceRef.current.calls = new Map([["uuid-2", call]]);

    const onAdopted = jest.fn();
    const unsub = track(await voiceLib.registerForIncoming(onInvite, onAdopted));
    await new Promise((r) => setImmediate(r));

    expect(onInvite).not.toHaveBeenCalled();
    expect(voiceLib.getPendingInvite()).toBeNull();
    expect(voiceLib.getActiveCall()).toBe(call);
    // Adopting silently left a live call with no in-app End/Hold/keypad: the app has to be told so
    // it can open the in-call screen.
    expect(onAdopted).toHaveBeenCalledWith("+61400000000");
    unsub();
    mockVoiceRef.current.pendingInvites = new Map();
    mockVoiceRef.current.calls = new Map();
  });

  // Every registration added its own native handler, so two live registrations -- a second tab
  // navigator pushed over a call by "add call"/"contacts", or a registration whose unsubscribe was
  // lost to an unmount mid-registration -- opened two ringing screens per call, and with auto-answer
  // on both accepted. One handler; the newest registration is the one told; removing it hands back.
  it("announces each invite once however many registrations are live, newest first", async () => {
    mockVoiceRef.current.pendingInvites = new Map();
    const first = jest.fn();
    const second = jest.fn();
    const unsubFirst = track(await voiceLib.registerForIncoming(first));
    const unsubSecond = await voiceLib.registerForIncoming(second);

    expect(mockVoiceRef.current.handlers["callInvite"]).toHaveLength(1);
    const a = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", a);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    a.fire(CallInviteEvent.Cancelled);

    unsubSecond();
    const b = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", b);
    expect(first).toHaveBeenCalledTimes(1);
    b.fire(CallInviteEvent.Cancelled);
    unsubFirst();
    expect(mockVoiceRef.current.handlers["callInvite"]).toHaveLength(0);
  });

  it("does not announce an invite twice when the event arrived first", async () => {
    const invite = makeInvite(CallInviteState.Pending);
    const onInvite = jest.fn();

    // Hold the replay open so the event provably lands first, which is the ordering that would
    // otherwise ring the user twice for one call.
    let release: (invites: Map<string, unknown>) => void = () => {};
    mockVoiceRef.current.getCallInvites = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const unsub = track(await voiceLib.registerForIncoming(onInvite));
    mockVoiceRef.current.emit("callInvite", invite);
    release(new Map([["uuid-1", invite]]));
    await new Promise((r) => setImmediate(r));

    expect(onInvite).toHaveBeenCalledTimes(1);
    unsub();
  });

  // Call waiting: answering the new call ends the current one. The ringing screen used to hang up
  // the current call FIRST and only then find out the new caller had already gone -- so a staff
  // member tapping Answer a moment too late lost both calls.
  function liveCallFake(order: string[]) {
    return {
      on: jest.fn(),
      getState: () => "connected",
      disconnect: jest.fn(() => { order.push("disconnect"); return Promise.resolve(); }),
    };
  }

  it("call waiting: a withdrawn invite leaves the call in progress connected", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const current = liveCallFake([]);
    voiceLib.setActiveCall(current);
    const invite = makeInvite(CallInviteState.Pending);
    mockVoiceRef.current.emit("callInvite", invite);

    invite.state = CallInviteState.Rejected;
    invite.fire(CallInviteEvent.Cancelled);

    await expect(voiceLib.acceptWaitingCall()).resolves.toBeNull();
    expect(current.disconnect).not.toHaveBeenCalled();
    expect(invite.accepted).toBe(false);
    unsub();
  });

  it("call waiting: a pending invite ends the current call, then is accepted", async () => {
    const unsub = track(await voiceLib.registerForIncoming(() => {}));
    const order: string[] = [];
    const current = liveCallFake(order);
    voiceLib.setActiveCall(current);
    const invite = makeInvite(CallInviteState.Pending);
    const accept = invite.accept.bind(invite);
    invite.accept = async () => { order.push("accept"); return accept(); };
    mockVoiceRef.current.emit("callInvite", invite);

    await expect(voiceLib.acceptWaitingCall()).resolves.not.toBeNull();
    expect(order).toEqual(["disconnect", "accept"]);
    expect(invite.accepted).toBe(true);
    unsub();
  });

  // The ringing screen is pushed after two awaited pref reads, so the caller can hang up before it
  // mounts -- and onInviteCancelled only reports cancellations that happen AFTER it subscribes.
  describe("ringingScreenOnMount", () => {
    it("rings while the invite is still pending", async () => {
      const unsub = track(await voiceLib.registerForIncoming(() => {}));
      mockVoiceRef.current.emit("callInvite", makeInvite(CallInviteState.Pending));
      expect(voiceLib.ringingScreenOnMount(false)).toBe("ring");
      unsub();
    });

    it("dismisses when the caller gave up before the screen mounted", async () => {
      const unsub = track(await voiceLib.registerForIncoming(() => {}));
      const invite = makeInvite(CallInviteState.Pending);
      mockVoiceRef.current.emit("callInvite", invite);
      invite.state = CallInviteState.Rejected;
      invite.fire(CallInviteEvent.Cancelled);
      expect(voiceLib.ringingScreenOnMount(false)).toBe("dismiss");
      unsub();
    });

    // Answered from CallKit before the screen mounted: dismissing would strand a live call with no
    // in-app controls, so the screen has to go to the in-call screen instead.
    it("opens the in-call screen for an invite already answered natively", async () => {
      const unsub = track(await voiceLib.registerForIncoming(() => {}));
      const invite = makeInvite(CallInviteState.Pending);
      mockVoiceRef.current.emit("callInvite", invite);
      invite.state = CallInviteState.Accepted;
      invite.fireWith(CallInviteEvent.Accepted, { on: jest.fn(), getState: () => "connected" });
      expect(voiceLib.ringingScreenOnMount(false)).toBe("in-call");
      unsub();
    });

    // During call waiting the live call is the one ALREADY on screen underneath, not this caller.
    it("dismisses a withdrawn call-waiting invite even though a call is live", async () => {
      const unsub = track(await voiceLib.registerForIncoming(() => {}));
      voiceLib.setActiveCall(liveCallFake([]));
      const invite = makeInvite(CallInviteState.Pending);
      mockVoiceRef.current.emit("callInvite", invite);
      invite.state = CallInviteState.Rejected;
      invite.fire(CallInviteEvent.Cancelled);
      expect(voiceLib.ringingScreenOnMount(true)).toBe("dismiss");
      unsub();
    });

    // The waiting call answered from CallKit before the ringing screen mounted: the live call is now
    // THIS caller. Dismissing left the in-call screen underneath tied to the old call, so the new call
    // had no screen and no hang-up button.
    it("opens the in-call screen for a call-waiting invite answered natively", async () => {
      const unsub = track(await voiceLib.registerForIncoming(() => {}));
      voiceLib.setActiveCall(liveCallFake([]));
      const invite = makeInvite(CallInviteState.Pending);
      mockVoiceRef.current.emit("callInvite", invite);
      invite.state = CallInviteState.Accepted;
      invite.fireWith(CallInviteEvent.Accepted, { on: jest.fn(), getState: () => "connected" });
      expect(voiceLib.ringingScreenOnMount(true)).toBe("in-call");
      unsub();
    });
  });
});

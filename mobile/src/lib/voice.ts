import { Platform, PermissionsAndroid, type Permission, type Rationale } from "react-native";
import { Voice, Call, CallInvite, PreflightTest } from "@twilio/voice-react-native-sdk";
import { getSoftphoneToken } from "./api";
import { chooseAudioDevice, type AudioRoutePref, type AudioDeviceLike } from "./audioRouting";
import { getPref, getPrefBool } from "./prefs";

// Single Voice instance for the app. Handles outbound dialing and, once registered, incoming
// calls (the server's TwiML app bridges `To` out to the PSTN; incoming arrives via FCM push).
const voice = new Voice();

// The call/invite currently in play, shared across screens (there is only ever one at a time).
let activeCall: Call | null = null;
let pendingInvite: CallInvite | null = null;

// Twilio registration status, surfaced in Settings so we can see on-device whether the softphone
// actually registered for incoming-call push (vs. failing silently).
let regStatus = "not started";
let regListeners: ((s: string) => void)[] = [];
function setRegStatus(s: string): void {
  regStatus = s;
  regListeners.forEach((l) => l(s));
}
export function getRegStatus(): string {
  return regStatus;
}
export function onRegStatus(fn: (s: string) => void): () => void {
  regListeners.push(fn);
  fn(regStatus);
  return () => {
    regListeners = regListeners.filter((l) => l !== fn);
  };
}

export function getActiveCall(): Call | null {
  return activeCall;
}
export function setActiveCall(c: Call | null): void {
  activeCall = c;
}
// Fires when a ringing invite is withdrawn (caller hung up, or another device answered), so the
// ringing screen can dismiss itself instead of leaving a dead Answer button on screen.
let inviteCancelledListeners: (() => void)[] = [];
export function onInviteCancelled(fn: () => void): () => void {
  inviteCancelledListeners.push(fn);
  return () => {
    inviteCancelledListeners = inviteCancelledListeners.filter((l) => l !== fn);
  };
}
// Fires when a ringing invite is ANSWERED -- including natively, from CallKit's own lock-screen or
// banner UI, which our React Native ringing screen otherwise never hears about. Without this the
// screen stays up with a live Accept button while the staff member is already talking, and tapping
// it accepts an already-accepted invite, which aborts the app down in TwilioVoice.
let inviteAcceptedListeners: (() => void)[] = [];
export function onInviteAccepted(fn: () => void): () => void {
  inviteAcceptedListeners.push(fn);
  return () => {
    inviteAcceptedListeners = inviteAcceptedListeners.filter((l) => l !== fn);
  };
}
function notifyInviteAccepted(): void {
  inviteAcceptedListeners.forEach((l) => {
    try {
      l();
    } catch {
      /* a listener must never break invite teardown */
    }
  });
}

function notifyInviteCancelled(): void {
  inviteCancelledListeners.forEach((l) => {
    try {
      l();
    } catch {
      /* a listener must never break invite teardown */
    }
  });
}

export function getPendingInvite(): CallInvite | null {
  return pendingInvite;
}

// ---- Audio routing ----
// Thin native glue over audioRouting.ts's pure `chooseAudioDevice`: maps the SDK's
// AudioDevice[] into AudioDeviceLike[], asks the pure helper which one to pick, then
// `.select()`s it via the SDK. Kept out of audioRouting.ts so that file stays jest-testable
// without a native SDK import.
function toLike(d: { uuid: string; type: string; name?: string }): AudioDeviceLike {
  return { uuid: d.uuid, type: d.type as AudioDeviceLike["type"], name: d.name };
}

export async function listAudioDevices(): Promise<{
  devices: AudioDeviceLike[];
  selectedType: AudioDeviceLike["type"] | null;
}> {
  const { audioDevices, selectedDevice } = await voice.getAudioDevices();
  return {
    devices: audioDevices.map(toLike),
    selectedType: (selectedDevice?.type as AudioDeviceLike["type"] | undefined) ?? null,
  };
}

export async function selectAudioRoute(pref: AudioRoutePref): Promise<void> {
  const { audioDevices } = await voice.getAudioDevices();
  const bluetoothAllowed = await getPrefBool("pref_bluetooth", true);
  const target = chooseAudioDevice(audioDevices.map(toLike), pref, bluetoothAllowed);
  if (!target) return;
  const match = audioDevices.find((d) => d.uuid === target.uuid);
  if (match) await match.select();
}

// Reads the user's saved route preference and applies it. Call this right after a call
// connects (fire-and-forget) so audio is routed correctly once the call is live.
export async function applyDefaultAudioRoute(): Promise<void> {
  const pref = (await getPref("pref_audio_route", "automatic")) as AudioRoutePref;
  await selectAudioRoute(pref).catch(() => {});
}

export function onAudioDevicesUpdated(cb: (selectedType: AudioDeviceLike["type"] | null) => void): () => void {
  const handler = (_devices: unknown, selected?: { type?: string }) =>
    cb((selected?.type as AudioDeviceLike["type"] | undefined) ?? null);
  voice.on(Voice.Event.AudioDevicesUpdated, handler);
  return () => voice.off(Voice.Event.AudioDevicesUpdated, handler);
}

async function requestAndroid(permission: Permission, rationale?: Rationale): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const granted = await PermissionsAndroid.request(permission, rationale);
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

async function ensureMicPermission(): Promise<void> {
  const ok = await requestAndroid(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: "Microphone access",
    message: "TCB Phone needs your microphone to make and take calls.",
    buttonPositive: "Allow",
  });
  if (!ok) throw new Error("Microphone permission is required for calls.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Which push credential the minted access token should carry. Written out at four call sites
// before this, which is four chances for one of them to drift onto the wrong platform -- and a
// token minted against the wrong credential registers happily and is never woken (see the
// "missing VoIP push credential" note in the root CLAUDE.md).
function tokenPlatform(): "ios" | "android" {
  return Platform.OS === "ios" ? "ios" : "android";
}

// Creates the PKPushRegistry, and it must happen AS EARLY AS POSSIBLE in app startup.
//
// This is the 0xBAADCA11 crash. When a VoIP push arrives, iOS launches the app in the background
// and gives it roughly FIVE SECONDS to report the call to CallKit; miss that and FrontBoard SIGKILLs
// the process ("BAADCA11" -- bad call). The crash log from 2026-09-10 is exactly that: procRole
// "Non UI", phone locked, launched 11:38:11 and killed 11:38:18.
//
// The registry used to be created inside registerForIncoming, which is gated behind the JS bundle
// booting, auth resolving from SecureStore, the tab navigator mounting, its effect firing, and a
// microphone permission check -- and only THEN did it run, with a network round trip for the access
// token after it. On a warm foreground app that is invisible, because the registry already exists.
// On the cold background wake that a real incoming call actually is, it is far too late, and the
// handset is killed instead of ringing.
//
// Priming it at launch is a mitigation, not the whole cure: the proper fix is for the PushKit
// delegate to be installed in native code before JS runs at all, which needs a config plugin and a
// new native build. This at least removes auth, navigation and a network call from the critical path.
let pushRegistryPrimed: Promise<void> | null = null;

// A failure is REMEMBERED, not cached as success. Assigning the promise returned by `.catch()`
// would memoise a rejection as a permanently-resolved one: every later call -- a re-login, a tab
// remount, a second registerForIncoming -- would await that resolved promise, the registry would
// never be built again, and the handset would silently take no incoming calls until it was force
// quit. The old code created it on every registerForIncoming and so recovered on its own; losing
// that would have been a worse bug than the one being fixed.
let pushRegistryError: string | null = null;

export function primePushRegistry(): Promise<void> {
  if (Platform.OS !== "ios") return Promise.resolve();
  // Idempotent while in flight or successful; retryable once it has failed.
  if (!pushRegistryPrimed) {
    pushRegistryError = null;
    pushRegistryPrimed = voice
      .initializePushRegistry()
      .then(() => {
        pushRegistryError = null;
      })
      .catch((e: unknown) => {
        // Never throw from app startup: a registry that cannot be built means incoming calls will
        // not arrive, but it must not also stop the app from opening. The reason is kept so the
        // registration path can report THIS error rather than the misleading one it would
        // otherwise produce, and the slot is cleared so the next attempt actually retries.
        pushRegistryError = e instanceof Error ? e.message : String(e);
        pushRegistryPrimed = null;
      });
  }
  return pushRegistryPrimed;
}

export function getPushRegistryError(): string | null {
  return pushRegistryError;
}

// On iOS, `voice.register()` needs a PushKit device token that iOS hasn't necessarily handed
// over yet -- on a cold launch `pushRegistry:didUpdatePushCredentials:forType:` can take up to
// ~30s to fire, but Twilio's native code only waits 3s before rejecting with "Failed to
// initialize PushKit device token". Retry with backoff on that specific error; anything else
// (bad access token, network) fails fast.
const PUSHKIT_BACKOFF_MS = [0, 1000, 2000, 3000, 5000, 8000, 10000];
async function registerWithRetry(token: string): Promise<void> {
  for (let attempt = 0; attempt < PUSHKIT_BACKOFF_MS.length; attempt++) {
    if (PUSHKIT_BACKOFF_MS[attempt] > 0) await sleep(PUSHKIT_BACKOFF_MS[attempt]);
    try {
      await voice.register(token);
      return;
    } catch (e) {
      const isPushKitRace = e instanceof Error && e.message.includes("PushKit device token");
      const isLastAttempt = attempt === PUSHKIT_BACKOFF_MS.length - 1;
      if (!isPushKitRace || isLastAttempt) throw e;
      setRegStatus(`registering… (retry ${attempt + 1})`);
    }
  }
}

// ---- Outbound ----
// `from` optionally sets the caller-ID (validated server-side in /twiml/voice-app against the
// business's voice-enabled numbers); omit to use the default number.
export async function placeCall(to: string, from?: string): Promise<Call> {
  await ensureMicPermission();
  const token = await getSoftphoneToken(tokenPlatform());
  const params: Record<string, string> = { To: to };
  if (from) params.CallerId = from;
  const call = await voice.connect(token, { params });
  activeCall = call;
  // Identity-guarded: if a call-waiting swap has already moved `activeCall` to a newer
  // call by the time this call terminates, don't clobber it.
  call.on(Call.Event.Disconnected, () => {
    if (activeCall === call) activeCall = null;
  });
  call.on(Call.Event.ConnectFailure, () => {
    if (activeCall === call) activeCall = null;
  });
  applyDefaultAudioRoute().catch(() => {});
  return call;
}

// ---- Incoming registration ----
// Register this device to receive incoming calls via push, and wire the CallInvite handler.
// `onInvite` is called (with the caller's number) when a call comes in, so the UI can navigate
// to the ringing screen. Returns an unsubscribe function.
export async function registerForIncoming(onInvite: (from: string) => void): Promise<() => void> {
  // Android 13+ needs notification permission to show the incoming-call banner. Best-effort —
  // registration still proceeds if declined (the call just won't post a heads-up notification).
  if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
    await requestAndroid(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
  }
  // Android 12+ puts Bluetooth devices behind a runtime grant. The Twilio SDK declares
  // BLUETOOTH_CONNECT in its own manifest, but a manifest entry alone isn't enough: without the
  // runtime grant the SDK can't enumerate a headset, so `getAudioDevices()` never reports a
  // bluetooth device and both the Audio Routing setting and the in-call Bluetooth button
  // silently do nothing. Best-effort -- declining just leaves earpiece/speaker.
  if (Platform.OS === "android" && Number(Platform.Version) >= 31) {
    await requestAndroid(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT, {
      title: "Bluetooth access",
      message: "TCB Phone needs Bluetooth access to play call audio through your headset.",
      buttonPositive: "Allow",
    }).catch(() => {});
  }
  await ensureMicPermission().catch(() => {});

  const handler = (invite: CallInvite) => {
    pendingInvite = invite;
    // A withdrawn invite MUST drop out of `pendingInvite`. Accepting one that is no longer pending
    // throws deep in TwilioVoice's native CallKit path, as an Objective-C exception that no JS
    // try/catch can reach -- it aborts the whole app. That is the 09:14 crash: the caller hung up
    // at :34 and the process died at :35 inside -[CXProvider performAction:] -> TVOAcceptOptions.
    // The window is easy to hit: auto-answer fires on a timer, and CallKit's own Answer button is
    // live the whole time the screen is up.
    invite.on(CallInvite.Event.Cancelled, () => {
      if (pendingInvite === invite) pendingInvite = null;
      notifyInviteCancelled();
    });
    // Answered somewhere other than our own screen -- CallKit's native UI, or the SDK auto-accepting.
    // Adopt the resulting Call so the in-call screen has something to drive, drop the invite so no
    // second accept can reach the native layer, and tell the ringing screen to get out of the way.
    invite.on(CallInvite.Event.Accepted, (call: Call) => {
      if (pendingInvite === invite) pendingInvite = null;
      if (call) {
        activeCall = call;
        call.on(Call.Event.Disconnected, () => {
          if (activeCall === call) activeCall = null;
        });
        call.on(Call.Event.ConnectFailure, () => {
          if (activeCall === call) activeCall = null;
        });
      }
      notifyInviteAccepted();
    });
    onInvite(invite.getFrom());
  };
  voice.on(Voice.Event.CallInvite, handler);
  // An invite delivered BEFORE this listener existed is never re-emitted -- the SDK's
  // sendEventWithName is a no-op until JS subscribes. That window is real now that the native
  // module is built during launch (mobile/plugins/TwilioEarlyInit.swift): a cold launch from a
  // VoIP push reports the call to CallKit natively and starts ringing while the bundle is still
  // booting, so the phone can be answered from the CallKit screen with JS holding no invite at
  // all -- an in-call screen driving nothing, which is the shape of the unresolved "no hang-up
  // button" report. The SDK keeps pending invites, so ask for the one already in flight.
  // Deliberately not awaited: registration must not wait on it, and a missing method (an older
  // SDK) must degrade to today's behaviour rather than break registering entirely.
  void Promise.resolve()
    .then(() => voice.getCallInvites())
    .then((invites) => {
      // Only when nothing came through the event first, so an invite is never announced twice.
      if (pendingInvite) return;
      const [waiting] = Array.from(invites.values());
      if (waiting) handler(waiting);
    })
    .catch(() => {});
  const onRegistered = () => setRegStatus("registered ✓");
  const onError = (e: unknown) => setRegStatus("error: " + ((e as { message?: string })?.message ?? String(e)));
  voice.on(Voice.Event.Registered, onRegistered);
  voice.on(Voice.Event.Error, onError);

  setRegStatus("registering…");
  try {
    // iOS ONLY: the SDK does not auto-create the PKPushRegistry. Because this is a managed Expo
    // app with no PushKit module of our own, we must call initializePushRegistry() at launch so
    // the SDK sets up the registry and iOS begins delivering the VoIP device token. Without this,
    // `register()` waits for a token that never arrives and fails with "Failed to initialize
    // PushKit device token" -- permanently, not a timing race. (No-op/throws on Android, which
    // uses FCM instead, so it's guarded to iOS.)
    // Already primed at app launch (see primePushRegistry). Awaited here so registration still
    // orders correctly behind it, but it is no longer this path's job to create it.
    await primePushRegistry();
    // Fail FAST and accurately when the registry could not be built. Without this, register()
    // fails with "Failed to initialize PushKit device token", registerWithRetry classifies that as
    // the cold-launch token race and burns its whole ~29s backoff, and the status ends up naming a
    // cause that is not what happened -- while the real reason, recorded at launch, is overwritten.
    const primeError = getPushRegistryError();
    if (primeError !== null) throw new Error("PushKit registry unavailable: " + primeError);
    const token = await getSoftphoneToken(tokenPlatform());
    await registerWithRetry(token);
    // Some SDK versions resolve register() without emitting Registered; treat a clean resolve as ok.
    if (regStatus === "registering…") setRegStatus("registered ✓");
  } catch (e) {
    setRegStatus("register failed: " + (e instanceof Error ? e.message : String(e)));
  }

  return () => {
    voice.off(Voice.Event.CallInvite, handler);
    voice.off(Voice.Event.Registered, onRegistered);
    voice.off(Voice.Event.Error, onError);
  };
}

// Tell Twilio to stop sending this device incoming calls.
//
// Nothing did this before, and the consequence is not subtle: registration is a binding held by
// TWILIO, not a local flag, so a handset stayed registered forever. Logging out cleared the session
// token and nothing else -- the phone kept receiving VoIP pushes for `client:{email}` and kept
// ringing for real customers, on a device nobody was signed in on. Observed on an Android handset
// that was logged out and rang anyway (2026-09-11).
//
// ORDER MATTERS: `unregister` needs an access token, and minting one needs the session. This must
// run BEFORE the session is cleared, which is why `performSignOut` awaits it first.
//
// WHAT THIS DOES NOT COVER, and cannot: a REMOVED staff member, or anyone whose session is revoked
// from the server (a password reset, `handleRemoveStaff`), never taps Sign Out. They hit a 401,
// `apiFetch` clears the token and drops the app to anon, and from that moment there is no session
// left to mint the token an unregister needs -- so that handset stays registered, keeps ringing and
// can still ANSWER a live customer call. Only a voluntary sign-out is fixed here. Closing that hole
// needs the SERVER to be able to drop the binding, which Twilio does not expose; the nearest
// practical mitigation is the sibling `push_tokens` scrub `handleRemoveStaff` already does.
//
// Best-effort and BOUNDED. `apiFetch` has no timeout, so an unsettled token request would hang
// sign-out and trap someone in an app they are trying to leave -- the same "module state plus a
// timeout-less fetch is a permanent wedge" trap recorded for placeCall. Logging out must always
// complete, so this races a deadline and gives up. A failed unregister leaves the handset ringing,
// which is bad, but strictly better than being unable to log out at all -- and the caller SURFACES
// that failure (see `performSignOut` -> the Settings sign-out row), because `regStatus` alone
// cannot: it renders only on the Settings screen, which is inside the authed tab group and is
// unmounting by the time this runs.
const UNREGISTER_TIMEOUT_MS = 5000;

export async function unregisterFromIncoming(): Promise<boolean> {
  // A phone that is RINGING as its owner signs out has to stop, and the caller has to fall through
  // to the next person rather than wait out the whole ring window behind a leg nobody is going to
  // answer. Unregistering alone does not do that -- the invite is already delivered and the CallKit
  // / notification UI is already up. Safe on a settled invite: rejectIncoming guards on the state.
  await rejectIncoming().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const done = (async () => {
      const token = await getSoftphoneToken(tokenPlatform());
      await voice.unregister(token);
      return true;
    })();
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), UNREGISTER_TIMEOUT_MS);
    });
    const ok = await Promise.race([done, timedOut]);
    setRegStatus(ok ? "unregistered" : "unregister timed out — this phone may still ring");
    return ok;
  } catch (e) {
    setRegStatus("unregister failed: " + (e instanceof Error ? e.message : String(e)));
    return false;
  } finally {
    // The deadline must not outlive the race it bounds. Left uncleared it holds a timer open for
    // five seconds after every sign-out, and in Jest it is an open handle that force-exits the
    // worker -- which is how it was found.
    if (timer !== undefined) clearTimeout(timer);
  }
}

// The currently-live call, or null. Guards every "the call is already up, hand it back" path: a
// disconnected leftover must never be presented as an active call, or the in-call screen drives a
// dead object.
function liveCall(): Call | null {
  const call = activeCall;
  if (!call) return null;
  try {
    return call.getState() === Call.State.Disconnected ? null : call;
  } catch {
    return null;
  }
}

export async function acceptIncoming(): Promise<Call | null> {
  const invite = pendingInvite;
  // No pending invite. Either CallKit already answered it -- the Accepted handler adopts the Call
  // and clears `pendingInvite`, so the call is LIVE and we hand it back -- or the invite is gone,
  // and `activeCall` is null, which correctly reads as "nothing to show". Returning a bare null
  // here is what produced a black screen in front of a connected call.
  if (!invite) return liveCall();
  // Guard the accept on the invite still being pending. The SDK also accepts invites natively via
  // CallKit, so by the time this runs the invite may already be accepted, rejected or cancelled --
  // and calling accept() again aborts the process rather than throwing something catchable.
  // Returning null lets the caller dismiss the ringing screen cleanly.
  if (invite.getState() !== CallInvite.State.Pending) {
    pendingInvite = null;
    // Already ACCEPTED means CallKit answered it and the call is LIVE -- hand back the Call we
    // adopted from the Accepted event so the caller lands on the in-call screen. Returning null
    // here instead is what put a black screen in front of a connected call: the ringing screen
    // read it as "answer failed" and popped itself off an otherwise empty stack.
    // Cancelled/rejected leaves activeCall null, which correctly reads as "nothing to show".
    return liveCall();
  }
  const call = await invite.accept();
  activeCall = call;
  // Identity-guarded: if a call-waiting swap has already moved `activeCall` to a newer
  // call by the time this call terminates, don't clobber it.
  call.on(Call.Event.Disconnected, () => {
    if (activeCall === call) activeCall = null;
  });
  call.on(Call.Event.ConnectFailure, () => {
    if (activeCall === call) activeCall = null;
  });
  pendingInvite = null;
  applyDefaultAudioRoute().catch(() => {});
  return call;
}

export async function rejectIncoming(): Promise<void> {
  const invite = pendingInvite;
  pendingInvite = null;
  // Same guard as accept: rejecting an already-settled invite is not a no-op in the native layer.
  if (invite && invite.getState() === CallInvite.State.Pending) await invite.reject();
}

export { Call };


// ---------------------------------------------------------------------------
// Connection test (Settings -> Test Connection)
//
// Runs Twilio's PreflightTest: a short real call to Twilio that samples this device's network and
// returns jitter, round-trip time and MOS (mean opinion score, 1.0-4.5 -- the standard measure of
// perceived call quality). It exists because "the call sounded bad" is otherwise unfalsifiable:
// Twilio's Voice Insights reports the CARRIER leg, but the leg that usually degrades is this one,
// the phone's own connection to Twilio, and nothing measured it.
//
// The test call goes out through our own TwiML app, which answers a request with no `To` using
// <Echo/> (see /twiml/voice-app in src/worker.ts) so the media loops back for sampling. It dials
// nobody and rings no staff.
// ---------------------------------------------------------------------------

export type ConnectionTestResult = {
  // Twilio's own banding of average MOS: excellent | great | good | fair | degraded.
  quality: string | null;
  mos: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  edge: string | null;
  warnings: string[];
};

// Preflight normally takes ~10s. Cap it so a wedged test can't leave the button spinning forever.
const PREFLIGHT_TIMEOUT_MS = 45000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

export async function runConnectionTest(): Promise<ConnectionTestResult> {
  const token = await getSoftphoneToken(tokenPlatform());
  const test = await voice.runPreflight(token);

  return new Promise<ConnectionTestResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("The connection test timed out."))),
      PREFLIGHT_TIMEOUT_MS
    );

    test.on(PreflightTest.Event.Completed, (report: any) => {
      finish(() => {
        const stats = report?.stats ?? {};
        resolve({
          quality: report?.callQuality ?? null,
          mos: num(stats?.mos?.average),
          jitterMs: num(stats?.jitter?.average),
          rttMs: num(stats?.rtt?.average),
          edge: report?.selectedEdge ?? report?.edge ?? null,
          // Warning entries are objects; keep just the names, which is what a human can act on.
          warnings: Array.isArray(report?.warnings)
            ? report.warnings.map((w: any) => String(w?.name ?? w)).filter(Boolean)
            : [],
        });
      });
    });

    test.on(PreflightTest.Event.Failed, (err: unknown) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

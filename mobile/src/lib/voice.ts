import { Platform, PermissionsAndroid, type Permission, type Rationale } from "react-native";
import { Voice, Call, CallInvite, PreflightTest } from "@twilio/voice-react-native-sdk";
import { getSoftphoneToken } from "./api";
import { chooseAudioDevice, type AudioRoutePref, type AudioDeviceLike } from "./audioRouting";
import { getPref, getPrefBool } from "./prefs";
import { toE164 } from "./phone";

// Single Voice instance for the app. Handles outbound dialing and, once registered, incoming
// calls (the server's TwiML app bridges `To` out to the PSTN; incoming arrives via FCM push).
const voice = new Voice();

// The OS-level call notification (Android's heads-up notification, iOS CallKit's banner/lock-screen
// UI) is built by the native SDK straight from the invite's own signalling data, before JS ever
// runs -- so callerNumberFromInvite() below, which only fixes what OUR ringing/in-call screens
// render, can never reach it. Twilio's own answer is this template: it substitutes a named custom
// Client parameter into the native notification/handle text. The server attaches a "CallerNumber"
// parameter to every client: leg now (see dialStaff in CallSession.ts and handlePostTransfer in
// softphone.ts) specifically so this always resolves -- an unresolved key here would be worse than
// the business number it replaces. Fire-and-forget: a failure here must not stop the app opening,
// same reasoning as primePushRegistry, and per Twilio's docs the value is cached natively so it
// survives a cold launch where JS has not run yet.
voice.setIncomingCallContactHandleTemplate("${CallerNumber}").catch(() => {});

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

// Raised by every unregisterFromIncoming. A registration captures it when it starts and stops the
// moment it moves: the retries above run for ~29s with a token already minted, so a sign-out inside
// that window unregistered successfully and the pending retry then registered the signed-out handset
// again -- which kept receiving VoIP pushes that CallKit rings natively. Monotonic, so a registration
// started after the sign-out (the next person signing in) is unaffected.
//
// Raised only by the unregister, not by the last invite subscriber leaving: a registration's own
// subscriber stays in the stack until registerForIncoming returns, so that can never happen while a
// retry is pending -- and the tabs layout's cleanup runs AFTER performSignOut's unregister anyway.
let registrationGeneration = 0;

// False when a sign-out overtook it: nothing is registered and the status must not say otherwise.
async function registerWithRetry(token: string, generation: number): Promise<boolean> {
  for (let attempt = 0; attempt < PUSHKIT_BACKOFF_MS.length; attempt++) {
    if (PUSHKIT_BACKOFF_MS[attempt] > 0) await sleep(PUSHKIT_BACKOFF_MS[attempt]);
    if (generation !== registrationGeneration) return false;
    try {
      await voice.register(token);
      // Already in flight when the unregister ran, and landed after it: undo it. Best-effort, the
      // same as the sign-out's own unregister.
      if (generation !== registrationGeneration) {
        await voice.unregister(token).catch(() => {});
        return false;
      }
      return true;
    } catch (e) {
      if (generation !== registrationGeneration) return false;
      const isPushKitRace = e instanceof Error && e.message.includes("PushKit device token");
      const isLastAttempt = attempt === PUSHKIT_BACKOFF_MS.length - 1;
      if (!isPushKitRace || isLastAttempt) throw e;
      setRegStatus(`registering… (retry ${attempt + 1})`);
    }
  }
  return false; // unreachable: the last attempt returns or throws
}

// ---- Outbound ----
// `from` optionally sets the caller-ID (validated server-side in /twiml/voice-app against the
// business's voice-enabled numbers); omit to use the default number.
// Bumped whenever a call becomes, or starts becoming, the active one. A placeCall that settles after
// a newer call has started (End tapped mid-placement, then a redial) hands its call back to the
// screen to hang up, but must not take `activeCall` from the newer call.
let callGeneration = 0;

export async function placeCall(to: string, from?: string): Promise<Call> {
  const generation = ++callGeneration;
  await ensureMicPermission();
  const token = await getSoftphoneToken(tokenPlatform());
  // CallerNumber isn't about caller ID here -- it's what setIncomingCallContactHandleTemplate reads
  // to fill in Android's outgoing/answered call notification (that template is global, so leaving
  // this one leg without the key it expects would render blank instead of the dialled number).
  const params: Record<string, string> = { To: to, CallerNumber: to };
  if (from) params.CallerId = from;
  const call = await voice.connect(token, { params });
  if (generation !== callGeneration) return call;
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

// Makes an answered call the one the in-call screen drives, and lets go of it when it ends.
function adoptCall(call: Call): void {
  callGeneration++;
  activeCall = call;
  call.on(Call.Event.Disconnected, () => {
    if (activeCall === call) activeCall = null;
  });
  call.on(Call.Event.ConnectFailure, () => {
    if (activeCall === call) activeCall = null;
  });
}

// ---- Incoming registration ----
// Register this device to receive incoming calls via push, and wire the CallInvite handler.
// `onInvite` is called (with the caller's number) when a call comes in, so the UI can navigate
// to the ringing screen. Returns an unsubscribe function.
// `onAdopted` is called when a call was already answered (from CallKit) before JS subscribed, so the
// UI can open the in-call screen for it -- otherwise it is live with no in-app controls.
export async function registerForIncoming(
  onInvite: (from: string) => void,
  onAdopted?: (from: string) => void
): Promise<() => void> {
  const generation = registrationGeneration;
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

  const me: InviteSubscriber = { onInvite, onAdopted };
  inviteSubscribers.push(me);
  if (inviteSubscribers.length === 1) {
    voice.on(Voice.Event.CallInvite, handleInvite);
    voice.on(Voice.Event.Registered, onRegistered);
    voice.on(Voice.Event.Error, onRegError);
  }
  // An invite delivered BEFORE this listener existed is never re-emitted -- the SDK's
  // sendEventWithName is a no-op until JS subscribes. That window is real now that the native
  // module is built during launch (mobile/plugins/TwilioEarlyInit.swift): a cold launch from a
  // VoIP push reports the call to CallKit natively and starts ringing while the bundle is still
  // booting, so the phone can be answered from the CallKit screen with JS holding no invite at
  // all -- an in-call screen driving nothing, which is the shape of the unresolved "no hang-up
  // button" report. The SDK keeps pending invites, so ask for the one already in flight.
  // Deliberately not awaited: registration must not wait on it, and a missing method (an older
  // SDK) must degrade to today's behaviour rather than break registering entirely.
  //
  // An invite already ANSWERED from CallKit is not waiting: on iOS the SDK keeps it in
  // getCallInvites(), rebuilt as Pending, until the call ends. Announcing it rang a live call, every
  // Pending guard passed, and Decline hung up on the customer. Its Call sits in getCalls() under the
  // same uuid, so adopt that instead.
  void Promise.resolve()
    .then(() => Promise.all([voice.getCallInvites(), voice.getCalls()]))
    .then(([invites, calls]) => {
      // Only when nothing came through the event first, so an invite is never announced twice.
      if (pendingInvite) return;
      for (const [uuid, invite] of invites) {
        const answered = calls.get(uuid);
        if (answered) {
          if (!activeCall) {
            adoptCall(answered);
            currentSubscriber()?.onAdopted?.(callerNumberFromInvite(invite));
          }
          continue;
        }
        handleInvite(invite);
        return;
      }
    })
    .catch(() => {});

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
    const registered = await registerWithRetry(token, generation);
    // Some SDK versions resolve register() without emitting Registered; treat a clean resolve as ok.
    if (registered && regStatus === "registering…") setRegStatus("registered ✓");
  } catch (e) {
    // Signed out meanwhile (the token request 401s, say): the sign-out's own status stands.
    if (generation === registrationGeneration) {
      setRegStatus("register failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  return () => {
    const i = inviteSubscribers.indexOf(me);
    if (i < 0) return;
    inviteSubscribers.splice(i, 1);
    if (inviteSubscribers.length === 0) {
      voice.off(Voice.Event.CallInvite, handleInvite);
      voice.off(Voice.Event.Registered, onRegistered);
      voice.off(Voice.Event.Error, onRegError);
    }
  };
}

// ONE native invite handler however many registrations are live. Each registration used to add its
// own, so two live ones -- a second tab navigator pushed over a call by "add call"/"contacts", or a
// registration whose unsubscribe was lost to an unmount mid-registration -- opened two ringing
// screens per call, and with auto-answer on both accepted. The newest registration is the one told;
// removing it hands invites back to the one beneath.
type InviteSubscriber = { onInvite: (from: string) => void; onAdopted?: (from: string) => void };
const inviteSubscribers: InviteSubscriber[] = [];
const currentSubscriber = (): InviteSubscriber | undefined => inviteSubscribers[inviteSubscribers.length - 1];
const onRegistered = () => setRegStatus("registered ✓");
const onRegError = (e: unknown) => setRegStatus("error: " + ((e as { message?: string })?.message ?? String(e)));

// How the most recent invite ended, for a ringing screen that mounts after the fact.
let lastInviteOutcome: "accepted" | "cancelled" | null = null;

// The caller's REAL number for an incoming softphone call. Twilio's own `From` on a `client:`
// invite is always the BUSINESS number -- CallSession.ts's dialStaff never risks the real caller's
// number there, since Twilio's caller-ID-ownership rules are murky for a `client:` destination.
// The actual caller instead rides along as a custom Client parameter ("CallerNumber", set as a
// query param on the client URI), which is exactly what getCustomParameters() surfaces. Without
// this, every incoming call in the app showed the business's own number instead of who was
// actually calling -- the custom parameter was being sent all along and never read.
// Case-insensitive key match: this codebase has no prior evidence of which case the two native
// SDKs (iOS/Android) preserve it in, and a customer's number is worth a defensive lookup either way.
function callerNumberFromInvite(invite: CallInvite): string {
  const params = invite.getCustomParameters();
  const key = Object.keys(params).find((k) => k.toLowerCase() === "callernumber");
  const raw = key ? params[key] : undefined;
  return raw ? toE164(raw) : invite.getFrom();
}

function handleInvite(invite: CallInvite): void {
  pendingInvite = invite;
  lastInviteOutcome = null;
  // A withdrawn invite MUST drop out of `pendingInvite`. Accepting one that is no longer pending
  // throws deep in TwilioVoice's native CallKit path, as an Objective-C exception that no JS
  // try/catch can reach -- it aborts the whole app. That is the 09:14 crash: the caller hung up
  // at :34 and the process died at :35 inside -[CXProvider performAction:] -> TVOAcceptOptions.
  // The window is easy to hit: auto-answer fires on a timer, and CallKit's own Answer button is
  // live the whole time the screen is up.
  const withdrawn = () => {
    if (pendingInvite === invite) {
      pendingInvite = null;
      lastInviteOutcome = "cancelled";
    }
    notifyInviteCancelled();
  };
  invite.on(CallInvite.Event.Cancelled, withdrawn);
  // Declined from the native UI (the CallKit banner or lock screen, the Android call notification).
  // The SDK raises Rejected for that, never Cancelled, so without this the ringing screen stayed up
  // with live buttons for a call that no longer existed. Our own Decline also raises it; the screen's
  // actedRef makes the second dismiss a no-op.
  invite.on(CallInvite.Event.Rejected, withdrawn);
  // Answered somewhere other than our own screen -- CallKit's native UI, or the SDK auto-accepting.
  // Adopt the resulting Call so the in-call screen has something to drive, drop the invite so no
  // second accept can reach the native layer, and tell the ringing screen to get out of the way.
  invite.on(CallInvite.Event.Accepted, (call: Call) => {
    if (pendingInvite === invite) {
      pendingInvite = null;
      lastInviteOutcome = "accepted";
    }
    if (call) adoptCall(call);
    notifyInviteAccepted();
  });
  currentSubscriber()?.onInvite(callerNumberFromInvite(invite));
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
  // First, before any await: a registration still retrying must not register again behind this.
  registrationGeneration++;
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
  callGeneration++;
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

// Call waiting: answering the new call ends the current one -- but only once the new one can still
// be answered. Hanging up first and checking second meant a caller who gave up a moment before
// Answer cost the staff member BOTH calls. Null means "nothing to answer, leave the current call".
export async function acceptWaitingCall(): Promise<Call | null> {
  const invite = pendingInvite;
  if (!invite || invite.getState() !== CallInvite.State.Pending) return null;
  const current = liveCall();
  if (current) Promise.resolve(current.disconnect()).catch(() => {});
  return acceptIncoming();
}

// What a ringing screen should do as it mounts. It is pushed after awaited pref reads, so the invite
// can already be gone: withdrawn (dismiss), or answered from CallKit (go to the in-call screen, or
// the live call has no controls). For call waiting a live call alone proves nothing -- it may be the
// one already on screen underneath -- so there it takes this invite having been ANSWERED.
export function ringingScreenOnMount(waiting: boolean): "ring" | "in-call" | "dismiss" {
  if (pendingInvite?.getState() === CallInvite.State.Pending) return "ring";
  if (!liveCall()) return "dismiss";
  return !waiting || lastInviteOutcome === "accepted" ? "in-call" : "dismiss";
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

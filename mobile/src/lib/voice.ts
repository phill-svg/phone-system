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
  const token = await getSoftphoneToken(Platform.OS === "ios" ? "ios" : "android");
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
    onInvite(invite.getFrom());
  };
  voice.on(Voice.Event.CallInvite, handler);
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
    if (Platform.OS === "ios") {
      await voice.initializePushRegistry();
    }
    const token = await getSoftphoneToken(Platform.OS === "ios" ? "ios" : "android");
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

export async function acceptIncoming(): Promise<Call | null> {
  const invite = pendingInvite;
  if (!invite) return null;
  // Guard the accept on the invite still being pending. The SDK also accepts invites natively via
  // CallKit, so by the time this runs the invite may already be accepted, rejected or cancelled --
  // and calling accept() again aborts the process rather than throwing something catchable.
  // Returning null lets the caller dismiss the ringing screen cleanly.
  if (invite.getState() !== CallInvite.State.Pending) {
    pendingInvite = null;
    return null;
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
  const token = await getSoftphoneToken(Platform.OS === "ios" ? "ios" : "android");
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

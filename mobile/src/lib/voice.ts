import { Platform, PermissionsAndroid, type Permission, type Rationale } from "react-native";
import { Voice, Call, CallInvite } from "@twilio/voice-react-native-sdk";
import { getSoftphoneToken } from "./api";

// Single Voice instance for the app. Handles outbound dialing and, once registered, incoming
// calls (the server's TwiML app bridges `To` out to the PSTN; incoming arrives via FCM push).
const voice = new Voice();

// The call/invite currently in play, shared across screens (there is only ever one at a time).
let activeCall: Call | null = null;
let pendingInvite: CallInvite | null = null;

export function getActiveCall(): Call | null {
  return activeCall;
}
export function setActiveCall(c: Call | null): void {
  activeCall = c;
}
export function getPendingInvite(): CallInvite | null {
  return pendingInvite;
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

// ---- Outbound ----
export async function placeCall(to: string): Promise<Call> {
  await ensureMicPermission();
  const token = await getSoftphoneToken(Platform.OS === "ios" ? "ios" : "android");
  const call = await voice.connect(token, { params: { To: to } });
  activeCall = call;
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
  await ensureMicPermission().catch(() => {});

  const handler = (invite: CallInvite) => {
    pendingInvite = invite;
    onInvite(invite.getFrom());
  };
  voice.on(Voice.Event.CallInvite, handler);

  const token = await getSoftphoneToken(Platform.OS === "ios" ? "ios" : "android");
  await voice.register(token);

  return () => {
    voice.off(Voice.Event.CallInvite, handler);
  };
}

export async function acceptIncoming(): Promise<Call | null> {
  const invite = pendingInvite;
  if (!invite) return null;
  const call = await invite.accept();
  activeCall = call;
  pendingInvite = null;
  return call;
}

export async function rejectIncoming(): Promise<void> {
  const invite = pendingInvite;
  pendingInvite = null;
  if (invite) await invite.reject();
}

export { Call };

import { Platform, PermissionsAndroid } from "react-native";
import { Voice, Call } from "@twilio/voice-react-native-sdk";
import { getSoftphoneToken } from "./api";

// Single Voice instance for the app. Outbound dialing only for now — the server's TwiML app
// decides how to bridge `To` out to the PSTN. Incoming-call push (register) comes later.
const voice = new Voice();

async function ensureMicPermission(): Promise<void> {
  if (Platform.OS !== "android") return;
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: "Microphone access",
    message: "TCB Phone needs your microphone to make calls.",
    buttonPositive: "Allow",
  });
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error("Microphone permission is required to make calls.");
  }
}

export async function placeCall(to: string): Promise<Call> {
  await ensureMicPermission();
  const token = await getSoftphoneToken(Platform.OS === "ios" ? "ios" : "android");
  return voice.connect(token, { params: { To: to } });
}

export { Call };

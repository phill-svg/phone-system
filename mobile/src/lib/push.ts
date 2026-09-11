import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { registerPushToken } from "./api";

// Show notifications while the app is foregrounded too (Twilio calls have their own UI).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registered = false;

// The latch above is per app RUN, not per user, so signing out has to clear it.
//
// Without this, a second staff member signing in on the same handset never re-registers:
// `registerForPushNotifications` returns at the first line, the Expo token stays bound to the
// PREVIOUS user server-side (`upsertPushToken` is keyed on the token, so only a fresh call rebinds
// it), and the result is silent in both directions -- the new owner receives none of their own
// notifications, while the previous owner's inbound customer texts keep arriving on a phone they
// no longer hold, sender name and first 240 characters included.
export function resetPushRegistration(): void {
  registered = false;
}

// Ask for permission, grab the Expo push token, and hand it to the server. Safe to call repeatedly;
// only does the work once per app run. Never throws — push is best-effort.
export async function registerForPushNotifications(): Promise<void> {
  if (registered) return;
  try {
    if (!Device.isDevice) return; // no push on simulators/emulators

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("messages", {
        name: "Messages",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#D32F2F",
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (token) {
      const ok = await registerPushToken(token, Platform.OS);
      if (ok) registered = true;
    }
  } catch {
    // best-effort; ignore
  }
}

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

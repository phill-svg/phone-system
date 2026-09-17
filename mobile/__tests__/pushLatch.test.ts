/**
 * The push-registration latch is per SESSION, not per app run.
 *
 * A password reset revokes the session server-side; the app drops to login on the 401 without
 * signing out, so a boolean latch stayed set and the next person to sign in on that handset in the
 * same run never re-registered. The server binds the Expo token to the session that registered it,
 * so that handset would have gone quiet for the new user.
 */
import { registerForPushNotifications } from "../src/lib/push";

const mockRegister = jest.fn(async (_token: string, _platform: string) => true);
const mockSession: { token: string | null } = { token: "session-A" };

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[abc]" })),
  AndroidImportance: { HIGH: 4 },
}));
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("expo-constants", () => ({ expoConfig: { extra: { eas: { projectId: "p" } } } }));
jest.mock("../src/lib/api", () => ({ registerPushToken: (t: string, p: string) => mockRegister(t, p) }));
jest.mock("../src/lib/session", () => ({ getToken: async () => mockSession.token }));

describe("push registration latch", () => {
  it("registers once per session, and again when a different session signs in", async () => {
    await registerForPushNotifications();
    await registerForPushNotifications();
    expect(mockRegister).toHaveBeenCalledTimes(1);

    // Revoked on a password reset, then someone signs in again without the app restarting.
    mockSession.token = "session-B";
    await registerForPushNotifications();
    expect(mockRegister).toHaveBeenCalledTimes(2);
  });
});

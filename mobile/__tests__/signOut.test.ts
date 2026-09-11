/**
 * Sign-out has to undo things in ONE order, and the order is the whole fix.
 *
 * Telling Twilio to stop ringing this handset needs an access token, and minting one needs the
 * session -- so it must happen BEFORE the session is destroyed. Nothing pinned that: the first
 * version of this change lived inline in `auth.tsx`'s provider, `auth.test.tsx` is in
 * `testPathIgnorePatterns` (its renderer cannot resolve), and deleting the entire fix left all 176
 * tests green. "Testing the helper is not testing the call site."
 */
import { performSignOut } from "../src/lib/signOut";

const mockCalls: string[] = [];
const mockUnregister = jest.fn(async () => {
  mockCalls.push("unregister");
  return true;
});
const mockResetPush = jest.fn(() => {
  mockCalls.push("reset-push");
});

jest.mock("../src/lib/voice", () => ({ unregisterFromIncoming: mockUnregister }));
jest.mock("../src/lib/push", () => ({ resetPushRegistration: mockResetPush }));
jest.mock("../src/lib/api", () => ({
  logout: jest.fn(async () => {
    mockCalls.push("logout");
  }),
}));
jest.mock("../src/lib/session", () => ({
  clearToken: jest.fn(async () => {
    mockCalls.push("clearToken");
  }),
}));


describe("performSignOut", () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockUnregister.mockReset().mockImplementation(async () => {
      mockCalls.push("unregister");
      return true;
    });
    mockResetPush.mockClear();
  });

  it("stops the ringing BEFORE the session that authorises stopping it is destroyed", async () => {
    await performSignOut();
    // Order, not just membership: an unregister after clearToken cannot mint a token and is a
    // guaranteed no-op, which is indistinguishable from the bug this replaced.
    expect(mockCalls).toEqual(["unregister", "reset-push", "logout", "clearToken"]);
  });

  it("reports a handset that could not be unregistered, so the user can be told", async () => {
    mockUnregister.mockResolvedValue(false);
    await expect(performSignOut()).resolves.toEqual({ ringingStopped: false });
  });

  it("still signs out when the voice half fails outright", async () => {
    mockUnregister.mockRejectedValue(new Error("no native module"));
    await expect(performSignOut()).resolves.toEqual({ ringingStopped: false });
    // The session still has to go. Being unable to unregister must never mean being unable to leave.
    expect(mockCalls).toEqual(["reset-push", "logout", "clearToken"]);
  });

  it("clears the push-registration latch, or the next user on this handset gets no notifications", async () => {
    await performSignOut();
    expect(mockResetPush).toHaveBeenCalledTimes(1);
  });
});

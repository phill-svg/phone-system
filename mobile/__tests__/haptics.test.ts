/**
 * Reported live: on an unlocked iPhone, tapping Accept on the in-app incoming-call screen did
 * nothing at all -- no haptic, no accept, no dismiss. `haptics.success()` sat before the try/catch
 * in call-incoming.tsx's `answer()`, and `.catch(() => {})` on the returned promise only swallows
 * an ASYNC rejection -- it does nothing for a SYNCHRONOUS throw from the native call itself (e.g.
 * the module not linked/ready). That throw would abort `answer()` before accept() ever ran, with
 * no haptic felt and no visible change: exactly the symptom reported.
 */
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  notificationAsync: jest.fn(() => {
    throw new Error("native module not ready");
  }),
  impactAsync: jest.fn(() => {
    throw new Error("native module not ready");
  }),
  selectionAsync: jest.fn(() => {
    throw new Error("native module not ready");
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { haptics } = require("../src/theme/haptics");

describe("haptics", () => {
  it("never throws, even when the native call itself throws synchronously", () => {
    expect(() => haptics.success()).not.toThrow();
    expect(() => haptics.warning()).not.toThrow();
    expect(() => haptics.error()).not.toThrow();
    expect(() => haptics.tap()).not.toThrow();
    expect(() => haptics.press()).not.toThrow();
    expect(() => haptics.medium()).not.toThrow();
    expect(() => haptics.heavy()).not.toThrow();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blocksLeaving, createScreenExit, leaveAfterFailedHangup } from "../src/lib/nav";

// The in-call screen leaves once its call ends. router.back() pops whatever is on TOP, so leaving
// while another screen covers this one pops the wrong screen, and leaving twice pops two. Each of
// those shipped at least once in review: a stranded gestureless "Call Ended" modal, and End popping
// the screen the call was placed from.
function harness(focused: boolean) {
  const state = { focused, backs: 0 };
  const exit = createScreenExit({ isFocused: () => state.focused, back: () => { state.backs++; } });
  return { state, exit };
}

describe("createScreenExit", () => {
  it("leaves once when on top", () => {
    const { state, exit } = harness(true);
    exit.leave();
    exit.leave();
    expect(state.backs).toBe(1);
  });

  // A second call ringing, or Contacts tapped, inside the 600ms before the scheduled exit.
  it("does not pop a covering screen; leaves when uncovered instead", () => {
    const { state, exit } = harness(true);
    state.focused = false;
    exit.leave();
    expect(state.backs).toBe(0);
    state.focused = true;
    exit.onFocus();
    expect(state.backs).toBe(1);
  });

  it("does nothing on focus when no exit is pending", () => {
    const { state, exit } = harness(true);
    exit.onFocus();
    expect(state.backs).toBe(0);
  });

  // Android hardware back pops the screen mid-call; unmount disconnects, finish() runs on the dead
  // screen with its last focus value (true), and 600ms later popped the screen the user went back to.
  it("never leaves once disposed", () => {
    const { state, exit } = harness(true);
    exit.dispose();
    exit.leave();
    exit.onFocus();
    expect(state.backs).toBe(0);
  });

  it("End pressed before the scheduled exit still leaves only once", () => {
    const { state, exit } = harness(true);
    exit.leave(); // End
    exit.leave(); // the 600ms timer
    exit.onFocus();
    expect(state.backs).toBe(1);
  });
});

describe("blocksLeaving", () => {
  it("blocks Back while the call is being placed or is live, and lets an ended call go", () => {
    expect(blocksLeaving("calling")).toBe(true);
    expect(blocksLeaving("connected")).toBe(true);
    expect(blocksLeaving("ended")).toBe(false);
  });

  // Rule alone is not the fix: the screen has to hand it to usePreventRemove.
  it("is what the in-call screen uses to block removal", () => {
    const src = readFileSync(join(__dirname, "..", "src", "app", "call-active.tsx"), "utf8");
    expect(src).toMatch(/usePreventRemove\(\s*blocksLeaving\(state\)/);
  });
});

describe("leaveAfterFailedHangup", () => {
  it("stays on a call that may still be live after one failed hang-up, so End can be tapped again", () => {
    expect(leaveAfterFailedHangup(1, "connected")).toBe(false);
  });
  it("leaves once the call is really disconnected", () => {
    expect(leaveAfterFailedHangup(1, "disconnected")).toBe(true);
  });
  it("leaves after a second failed hang-up rather than trapping the screen", () => {
    expect(leaveAfterFailedHangup(2, "connected")).toBe(true);
  });
  it("is what the in-call screen consults when disconnect() rejects", () => {
    const src = readFileSync(join(__dirname, "..", "src", "app", "call-active.tsx"), "utf8");
    expect(src).toMatch(/leaveAfterFailedHangup\(/);
  });
});

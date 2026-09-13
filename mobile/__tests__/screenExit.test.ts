import { createScreenExit } from "../src/lib/nav";

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

  it("End pressed before the scheduled exit still leaves only once", () => {
    const { state, exit } = harness(true);
    exit.leave(); // End
    exit.leave(); // the 600ms timer
    exit.onFocus();
    expect(state.backs).toBe(1);
  });
});

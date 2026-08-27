import { decideInviteAction } from "../src/lib/callRouting";

describe("decideInviteAction", () => {
  it("first call: auto-answer on → answer-now, off → show-incoming", () => {
    expect(decideInviteAction({ hasActiveCall: false, autoAnswer: true, callWaiting: false })).toBe("answer-now");
    expect(decideInviteAction({ hasActiveCall: false, autoAnswer: false, callWaiting: false })).toBe("show-incoming");
  });
  it("second call: call-waiting on → show-waiting, off → reject", () => {
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: false, callWaiting: true })).toBe("show-waiting");
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: false, callWaiting: false })).toBe("reject");
  });
  it("second call never auto-answers", () => {
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: true, callWaiting: true })).toBe("show-waiting");
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: true, callWaiting: false })).toBe("reject");
  });
});

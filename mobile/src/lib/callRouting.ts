// Pure incoming-invite decision — NO native import, so jest can test it. The invite handler in
// (tabs)/_layout.tsx maps this decision to navigation / accept / reject on the native Call.
export type InviteAction = "answer-now" | "show-incoming" | "show-waiting" | "reject";

export function decideInviteAction(state: {
  hasActiveCall: boolean;
  autoAnswer: boolean;
  callWaiting: boolean;
}): InviteAction {
  if (state.hasActiveCall) return state.callWaiting ? "show-waiting" : "reject";
  return state.autoAnswer ? "answer-now" : "show-incoming";
}

// Pure dial-out state machine for a single `ring` node instance, run AFTER `resolveRingTargets`
// (src/dial/ringQueue.ts, Task 6) has already produced the number list to dial. This module never
// makes an outbound call, writes to D1, or touches `fetch` — it only decides WHAT should happen next,
// expressed as commands. Task 9 owns actually executing those commands (Twilio REST calls, D1 writes,
// tracking individual call-leg SIDs for simultaneous strategy) and feeding the resulting events back in.
//
// Same exhaustive matching-and-throwing convention as src/ivr/flowEngine.ts, but simpler: this is a
// plain synchronous reducer over in-memory state, not async/DB-backed.

export type RingStrategy = "cascade" | "simultaneous";

export type RingPlanState =
  | {
      name: "DIALING";
      strategy: RingStrategy;
      numbers: string[];
      // Index of the number currently ringing in cascade mode. Unused/irrelevant for
      // "simultaneous" — carried on the type purely for shape consistency between the two
      // strategies, not read or updated while strategy is "simultaneous".
      cascadeIndex: number;
    }
  | { name: "DONE"; outcome: "bridged" | "no_answer" | "callback_requested" };

export type RingPlanEvent =
  | { type: "START"; strategy: RingStrategy; numbers: string[] }
  | { type: "ATTEMPT_ANSWERED" }
  | { type: "ATTEMPT_FAILED" }
  | { type: "ALL_ATTEMPTS_EXHAUSTED" }
  | { type: "CALLBACK_STAR_PRESSED" };

export type RingPlanCommand =
  | { type: "DIAL_NEXT"; number: string }
  | { type: "DIAL_ALL"; numbers: string[] }
  | { type: "CANCEL_OTHER_ATTEMPTS" }
  | { type: "BRIDGED" }
  | { type: "NO_ANSWER" }
  | { type: "LOG_CALLBACK_REQUEST" }
  | { type: "CALLBACK_ACKNOWLEDGED" };

type ReduceResult = { state: RingPlanState; commands: RingPlanCommand[] };

export function reduceRingPlan(state: RingPlanState | null, event: RingPlanEvent): ReduceResult {
  if (state === null) {
    if (event.type !== "START") {
      throw new Error(`ringPlan: "${event.type}" event requires a START event first (state is null)`);
    }
    return startPlan(event);
  }

  if (event.type === "START") {
    throw new Error(`ringPlan: START event requires null state, but current state is "${state.name}"`);
  }

  if (state.name === "DONE") {
    throw new Error(`ringPlan: "${event.type}" event received but plan is already DONE (terminal state)`);
  }

  // state.name === "DIALING" from here on.
  switch (event.type) {
    case "ATTEMPT_ANSWERED":
      return {
        state: { name: "DONE", outcome: "bridged" },
        commands:
          state.strategy === "simultaneous"
            ? [{ type: "CANCEL_OTHER_ATTEMPTS" }, { type: "BRIDGED" }]
            : [{ type: "BRIDGED" }],
      };

    case "ATTEMPT_FAILED":
      if (state.strategy === "cascade") {
        const nextIndex = state.cascadeIndex + 1;
        if (nextIndex < state.numbers.length) {
          return {
            state: { ...state, cascadeIndex: nextIndex },
            commands: [{ type: "DIAL_NEXT", number: state.numbers[nextIndex] }],
          };
        }
        return { state: { name: "DONE", outcome: "no_answer" }, commands: [{ type: "NO_ANSWER" }] };
      }
      // Simultaneous: individual leg identities aren't tracked here (that's Task 9's caller
      // code, which holds the actual Twilio call SIDs). A single failed leg is a no-op at this
      // level — the caller keeps feeding ATTEMPT_FAILED per leg and fires ALL_ATTEMPTS_EXHAUSTED
      // once every leg has failed.
      return { state, commands: [] };

    case "ALL_ATTEMPTS_EXHAUSTED":
      if (state.strategy === "cascade") {
        throw new Error(
          'ringPlan: ALL_ATTEMPTS_EXHAUSTED is not valid for strategy "cascade" (cascade self-detects ' +
            "exhaustion via ATTEMPT_FAILED one at a time) — this indicates a caller bug"
        );
      }
      return { state: { name: "DONE", outcome: "no_answer" }, commands: [{ type: "NO_ANSWER" }] };

    case "CALLBACK_STAR_PRESSED":
      return {
        state: { name: "DONE", outcome: "callback_requested" },
        commands: [
          { type: "CANCEL_OTHER_ATTEMPTS" },
          { type: "LOG_CALLBACK_REQUEST" },
          { type: "CALLBACK_ACKNOWLEDGED" },
        ],
      };

    default:
      throw new Error(`ringPlan: unhandled event type "${(event as { type: string }).type}"`);
  }
}

function startPlan(event: { type: "START"; strategy: RingStrategy; numbers: string[] }): ReduceResult {
  if (event.numbers.length === 0) {
    // Mirrors resolveRingTargets' contract (Task 6): an empty ring list (e.g. an emergency ring
    // node targeting on_call_only with nobody currently on call) falls through cleanly to
    // "no answer", never throws.
    return { state: { name: "DONE", outcome: "no_answer" }, commands: [{ type: "NO_ANSWER" }] };
  }

  if (event.strategy === "cascade") {
    return {
      state: { name: "DIALING", strategy: "cascade", numbers: event.numbers, cascadeIndex: 0 },
      commands: [{ type: "DIAL_NEXT", number: event.numbers[0] }],
    };
  }

  return {
    state: { name: "DIALING", strategy: "simultaneous", numbers: event.numbers, cascadeIndex: 0 },
    commands: [{ type: "DIAL_ALL", numbers: event.numbers }],
  };
}

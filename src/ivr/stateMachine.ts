export type IvrState =
  | { name: "INCOMING" }
  | { name: "GREETING"; afterHours: boolean }
  | { name: "MAIN_MENU"; attempt: number }
  | { name: "AFTER_HOURS_MENU"; attempt: number }
  | { name: "ROUTE_STAFF"; tag: "new_booking" | "existing_job" | "emergency" | "operator" }
  | { name: "VOICEMAIL" };

export type IvrEvent =
  | { type: "CALL_INITIATED"; isAfterHours: boolean }
  | { type: "GREETING_SPOKEN" }
  | { type: "DIGIT_RECEIVED"; digit: string }
  | { type: "GATHER_TIMED_OUT" };

export type IvrCommand =
  | { type: "ANSWER" }
  | { type: "SPEAK"; text: string }
  | { type: "GATHER"; prompt: string; validDigits: string }
  | { type: "HANGUP" };

const DISCLOSURE = "This call may be recorded for quality and training purposes.";
const AFTER_HOURS_NOTICE =
  "Thanks for calling TCB Pest Control. Our office is currently closed. " + DISCLOSURE;
const MAIN_MENU_PROMPT =
  "Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone.";
const AFTER_HOURS_MENU_PROMPT = "For a pest emergency, press 1. Otherwise, please leave a message after the tone.";
const INVALID_DIGIT_TEXT = "Sorry, that wasn't a valid option.";
const VOICEMAIL_PROMPT =
  "Sorry we're unable to take your call right now. Please leave a message after the tone, including your name and number.";
const MAX_MAIN_MENU_ATTEMPTS = 3;

const MAIN_MENU_ROUTES: Record<string, IvrState & { name: "ROUTE_STAFF" }> = {
  "1": { name: "ROUTE_STAFF", tag: "new_booking" },
  "2": { name: "ROUTE_STAFF", tag: "existing_job" },
  "3": { name: "ROUTE_STAFF", tag: "emergency" },
  "0": { name: "ROUTE_STAFF", tag: "operator" },
};

function toVoicemail(): { state: IvrState; commands: IvrCommand[] } {
  return { state: { name: "VOICEMAIL" }, commands: [{ type: "SPEAK", text: VOICEMAIL_PROMPT }] };
}

export function reduce(state: IvrState, event: IvrEvent): { state: IvrState; commands: IvrCommand[] } {
  if (state.name === "INCOMING" && event.type === "CALL_INITIATED") {
    return {
      state: { name: "GREETING", afterHours: event.isAfterHours },
      commands: [
        { type: "ANSWER" },
        { type: "SPEAK", text: event.isAfterHours ? AFTER_HOURS_NOTICE : DISCLOSURE },
      ],
    };
  }

  if (state.name === "GREETING" && event.type === "GREETING_SPOKEN") {
    if (state.afterHours) {
      return {
        state: { name: "AFTER_HOURS_MENU", attempt: 1 },
        commands: [{ type: "GATHER", prompt: AFTER_HOURS_MENU_PROMPT, validDigits: "1" }],
      };
    }
    return {
      state: { name: "MAIN_MENU", attempt: 1 },
      commands: [{ type: "GATHER", prompt: MAIN_MENU_PROMPT, validDigits: "0123" }],
    };
  }

  if (state.name === "MAIN_MENU") {
    if (event.type === "DIGIT_RECEIVED" && MAIN_MENU_ROUTES[event.digit]) {
      return { state: MAIN_MENU_ROUTES[event.digit], commands: [] };
    }
    if (event.type === "DIGIT_RECEIVED" || event.type === "GATHER_TIMED_OUT") {
      if (state.attempt >= MAX_MAIN_MENU_ATTEMPTS) return toVoicemail();
      const commands: IvrCommand[] =
        event.type === "DIGIT_RECEIVED"
          ? [
              { type: "SPEAK", text: INVALID_DIGIT_TEXT },
              { type: "GATHER", prompt: MAIN_MENU_PROMPT, validDigits: "0123" },
            ]
          : [{ type: "GATHER", prompt: MAIN_MENU_PROMPT, validDigits: "0123" }];
      return { state: { name: "MAIN_MENU", attempt: state.attempt + 1 }, commands };
    }
  }

  if (state.name === "AFTER_HOURS_MENU") {
    if (event.type === "DIGIT_RECEIVED" && event.digit === "1") {
      return { state: { name: "ROUTE_STAFF", tag: "emergency" }, commands: [] };
    }
    if (event.type === "DIGIT_RECEIVED" || event.type === "GATHER_TIMED_OUT") {
      return toVoicemail();
    }
  }

  throw new Error(`Unhandled event ${event.type} in state ${state.name}`);
}

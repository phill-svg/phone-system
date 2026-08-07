import { describe, expect, it } from "vitest";
import { reduce, type IvrState } from "../../src/ivr/stateMachine";

describe("IVR state machine", () => {
  it("CALL_INITIATED (in hours) answers, plays disclosure, and moves to GREETING", () => {
    const { state, commands } = reduce({ name: "INCOMING" }, { type: "CALL_INITIATED", isAfterHours: false });
    expect(state).toEqual({ name: "GREETING", afterHours: false });
    expect(commands).toEqual([
      { type: "ANSWER" },
      { type: "SPEAK", text: "This call may be recorded for quality and training purposes." },
    ]);
  });

  it("CALL_INITIATED (after hours) plays the after-hours disclosure", () => {
    const { state, commands } = reduce({ name: "INCOMING" }, { type: "CALL_INITIATED", isAfterHours: true });
    expect(state).toEqual({ name: "GREETING", afterHours: true });
    expect(commands[1].type).toBe("SPEAK");
  });

  it("GREETING_SPOKEN (in hours) starts the main menu gather at attempt 1", () => {
    const { state, commands } = reduce({ name: "GREETING", afterHours: false }, { type: "GREETING_SPOKEN" });
    expect(state).toEqual({ name: "MAIN_MENU", attempt: 1 });
    expect(commands).toEqual([
      {
        type: "GATHER",
        prompt:
          "Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone.",
        validDigits: "0123",
      },
    ]);
  });

  it("GREETING_SPOKEN (after hours) starts the after-hours menu", () => {
    const { state } = reduce({ name: "GREETING", afterHours: true }, { type: "GREETING_SPOKEN" });
    expect(state).toEqual({ name: "AFTER_HOURS_MENU", attempt: 1 });
  });

  it.each([
    ["1", "new_booking"],
    ["2", "existing_job"],
    ["3", "emergency"],
    ["0", "operator"],
  ] as const)("MAIN_MENU digit %s routes to ROUTE_STAFF tag %s", (digit, tag) => {
    const { state, commands } = reduce({ name: "MAIN_MENU", attempt: 1 }, { type: "DIGIT_RECEIVED", digit });
    expect(state).toEqual({ name: "ROUTE_STAFF", tag });
    expect(commands).toEqual([]);
  });

  it("MAIN_MENU invalid digit re-prompts and increments the attempt", () => {
    const { state, commands } = reduce({ name: "MAIN_MENU", attempt: 1 }, { type: "DIGIT_RECEIVED", digit: "9" });
    expect(state).toEqual({ name: "MAIN_MENU", attempt: 2 });
    expect(commands[0]).toEqual({ type: "SPEAK", text: "Sorry, that wasn't a valid option." });
    expect(commands[1].type).toBe("GATHER");
  });

  it("MAIN_MENU invalid digit on the final attempt (3) goes to VOICEMAIL", () => {
    const { state, commands } = reduce({ name: "MAIN_MENU", attempt: 3 }, { type: "DIGIT_RECEIVED", digit: "9" });
    expect(state).toEqual({ name: "VOICEMAIL" });
    expect(commands.some((c) => c.type === "SPEAK")).toBe(true);
  });

  it("MAIN_MENU timeout re-prompts and increments the attempt", () => {
    const { state } = reduce({ name: "MAIN_MENU", attempt: 1 }, { type: "GATHER_TIMED_OUT" });
    expect(state).toEqual({ name: "MAIN_MENU", attempt: 2 });
  });

  it("MAIN_MENU timeout on the final attempt (3) goes to VOICEMAIL", () => {
    const { state } = reduce({ name: "MAIN_MENU", attempt: 3 }, { type: "GATHER_TIMED_OUT" });
    expect(state).toEqual({ name: "VOICEMAIL" });
  });

  it("AFTER_HOURS_MENU digit 1 routes to ROUTE_STAFF emergency", () => {
    const { state } = reduce({ name: "AFTER_HOURS_MENU", attempt: 1 }, { type: "DIGIT_RECEIVED", digit: "1" });
    expect(state).toEqual({ name: "ROUTE_STAFF", tag: "emergency" });
  });

  it("AFTER_HOURS_MENU timeout goes straight to VOICEMAIL (no retry)", () => {
    const { state } = reduce({ name: "AFTER_HOURS_MENU", attempt: 1 }, { type: "GATHER_TIMED_OUT" });
    expect(state).toEqual({ name: "VOICEMAIL" });
  });

  it("VOICEMAIL is terminal — commands include a HANGUP-free voicemail prompt", () => {
    const { commands } = reduce({ name: "MAIN_MENU", attempt: 3 }, { type: "GATHER_TIMED_OUT" });
    const speak = commands.find((c) => c.type === "SPEAK") as { type: "SPEAK"; text: string };
    expect(speak.text).toMatch(/leave a message/i);
  });
});

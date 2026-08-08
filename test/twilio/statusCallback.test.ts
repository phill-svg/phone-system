import { describe, expect, it } from "vitest";
import { normalizeCallStatus } from "../../src/twilio/statusCallback";

describe("normalizeCallStatus", () => {
  it.each([
    ["completed", "completed"],
    ["busy", "busy"],
    ["failed", "failed"],
    ["no-answer", "no_answer"],
    ["canceled", "canceled"],
  ] as const)("%s maps to %s", (input, expected) => {
    expect(normalizeCallStatus(input)).toBe(expected);
  });

  it.each(["queued", "ringing", "in-progress"])("%s (non-terminal) maps to null", (input) => {
    expect(normalizeCallStatus(input)).toBeNull();
  });
});

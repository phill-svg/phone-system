import { describe, expect, it } from "vitest";
import { reduceRingPlan } from "../../src/dial/ringPlan";
import type { RingPlanState } from "../../src/dial/ringPlan";

describe("reduceRingPlan", () => {
  describe("START", () => {
    it("empty numbers (cascade) -> DONE no_answer, [NO_ANSWER]", () => {
      const result = reduceRingPlan(null, { type: "START", strategy: "cascade", numbers: [] });
      expect(result.state).toEqual({ name: "DONE", outcome: "no_answer" });
      expect(result.commands).toEqual([{ type: "NO_ANSWER" }]);
    });

    it("empty numbers (simultaneous) -> DONE no_answer, [NO_ANSWER]", () => {
      const result = reduceRingPlan(null, { type: "START", strategy: "simultaneous", numbers: [] });
      expect(result.state).toEqual({ name: "DONE", outcome: "no_answer" });
      expect(result.commands).toEqual([{ type: "NO_ANSWER" }]);
    });

    it('cascade with numbers -> DIALING at index 0, [DIAL_NEXT number[0]]', () => {
      const result = reduceRingPlan(null, {
        type: "START",
        strategy: "cascade",
        numbers: ["+61400000001", "+61400000002", "+61400000003"],
      });
      expect(result.state).toEqual({
        name: "DIALING",
        strategy: "cascade",
        numbers: ["+61400000001", "+61400000002", "+61400000003"],
        cascadeIndex: 0,
      });
      expect(result.commands).toEqual([{ type: "DIAL_NEXT", number: "+61400000001" }]);
    });

    it("simultaneous with numbers -> DIALING, [DIAL_ALL all numbers]", () => {
      const result = reduceRingPlan(null, {
        type: "START",
        strategy: "simultaneous",
        numbers: ["+61400000001", "+61400000002", "+61400000003"],
      });
      expect(result.state).toEqual({
        name: "DIALING",
        strategy: "simultaneous",
        numbers: ["+61400000001", "+61400000002", "+61400000003"],
        cascadeIndex: 0,
      });
      expect(result.commands).toEqual([
        { type: "DIAL_ALL", numbers: ["+61400000001", "+61400000002", "+61400000003"] },
      ]);
    });

    it("throws if START fires when state is not null", () => {
      const dialing: RingPlanState = {
        name: "DIALING",
        strategy: "cascade",
        numbers: ["+61400000001"],
        cascadeIndex: 0,
      };
      expect(() =>
        reduceRingPlan(dialing, { type: "START", strategy: "cascade", numbers: ["+61400000002"] })
      ).toThrow();
    });
  });

  describe("cascade ring-down", () => {
    it("fail, fail, answer: advances cascadeIndex and dials the right number each time, then bridges", () => {
      const numbers = ["+61400000001", "+61400000002", "+61400000003"];
      let result = reduceRingPlan(null, { type: "START", strategy: "cascade", numbers });
      expect(result.commands).toEqual([{ type: "DIAL_NEXT", number: "+61400000001" }]);

      result = reduceRingPlan(result.state, { type: "ATTEMPT_FAILED" });
      expect(result.state).toEqual({ name: "DIALING", strategy: "cascade", numbers, cascadeIndex: 1 });
      expect(result.commands).toEqual([{ type: "DIAL_NEXT", number: "+61400000002" }]);

      result = reduceRingPlan(result.state, { type: "ATTEMPT_FAILED" });
      expect(result.state).toEqual({ name: "DIALING", strategy: "cascade", numbers, cascadeIndex: 2 });
      expect(result.commands).toEqual([{ type: "DIAL_NEXT", number: "+61400000003" }]);

      result = reduceRingPlan(result.state, { type: "ATTEMPT_ANSWERED" });
      expect(result.state).toEqual({ name: "DONE", outcome: "bridged" });
      expect(result.commands).toEqual([{ type: "BRIDGED" }]);
      expect(result.commands).not.toContainEqual({ type: "CANCEL_OTHER_ATTEMPTS" });
    });

    it("all fail: cascade exhaustion -> DONE no_answer, [NO_ANSWER]", () => {
      const numbers = ["+61400000001", "+61400000002"];
      let result = reduceRingPlan(null, { type: "START", strategy: "cascade", numbers });
      result = reduceRingPlan(result.state, { type: "ATTEMPT_FAILED" });
      expect(result.state).toEqual({ name: "DIALING", strategy: "cascade", numbers, cascadeIndex: 1 });

      result = reduceRingPlan(result.state, { type: "ATTEMPT_FAILED" });
      expect(result.state).toEqual({ name: "DONE", outcome: "no_answer" });
      expect(result.commands).toEqual([{ type: "NO_ANSWER" }]);
    });

    it("throws on ALL_ATTEMPTS_EXHAUSTED while DIALING cascade (caller bug, not reachable)", () => {
      const result = reduceRingPlan(null, {
        type: "START",
        strategy: "cascade",
        numbers: ["+61400000001"],
      });
      expect(() => reduceRingPlan(result.state, { type: "ALL_ATTEMPTS_EXHAUSTED" })).toThrow();
    });
  });

  describe("simultaneous batch", () => {
    it("ATTEMPT_FAILED is a no-op (state/commands unchanged) until ALL_ATTEMPTS_EXHAUSTED -> no_answer", () => {
      const numbers = ["+61400000001", "+61400000002", "+61400000003"];
      const start = reduceRingPlan(null, { type: "START", strategy: "simultaneous", numbers });

      const afterOneFail = reduceRingPlan(start.state, { type: "ATTEMPT_FAILED" });
      expect(afterOneFail.state).toEqual(start.state);
      expect(afterOneFail.commands).toEqual([]);

      const afterTwoFails = reduceRingPlan(afterOneFail.state, { type: "ATTEMPT_FAILED" });
      expect(afterTwoFails.state).toEqual(start.state);
      expect(afterTwoFails.commands).toEqual([]);

      const exhausted = reduceRingPlan(afterTwoFails.state, { type: "ALL_ATTEMPTS_EXHAUSTED" });
      expect(exhausted.state).toEqual({ name: "DONE", outcome: "no_answer" });
      expect(exhausted.commands).toEqual([{ type: "NO_ANSWER" }]);
    });

    it("ATTEMPT_ANSWERED -> bridged WITH CANCEL_OTHER_ATTEMPTS", () => {
      const start = reduceRingPlan(null, {
        type: "START",
        strategy: "simultaneous",
        numbers: ["+61400000001", "+61400000002"],
      });
      const result = reduceRingPlan(start.state, { type: "ATTEMPT_ANSWERED" });
      expect(result.state).toEqual({ name: "DONE", outcome: "bridged" });
      expect(result.commands).toEqual([{ type: "CANCEL_OTHER_ATTEMPTS" }, { type: "BRIDGED" }]);
    });
  });

  describe("cascade ATTEMPT_ANSWERED omits CANCEL_OTHER_ATTEMPTS", () => {
    it("bridges without a cancel command (only one number ever ringing at a time)", () => {
      const start = reduceRingPlan(null, {
        type: "START",
        strategy: "cascade",
        numbers: ["+61400000001", "+61400000002"],
      });
      const result = reduceRingPlan(start.state, { type: "ATTEMPT_ANSWERED" });
      expect(result.state).toEqual({ name: "DONE", outcome: "bridged" });
      expect(result.commands).toEqual([{ type: "BRIDGED" }]);
      expect(result.commands).not.toContainEqual({ type: "CANCEL_OTHER_ATTEMPTS" });
    });
  });

  describe("CALLBACK_STAR_PRESSED", () => {
    it("from cascade DIALING -> DONE callback_requested with cancel/log/ack commands", () => {
      const start = reduceRingPlan(null, {
        type: "START",
        strategy: "cascade",
        numbers: ["+61400000001"],
      });
      const result = reduceRingPlan(start.state, { type: "CALLBACK_STAR_PRESSED" });
      expect(result.state).toEqual({ name: "DONE", outcome: "callback_requested" });
      expect(result.commands).toEqual([
        { type: "CANCEL_OTHER_ATTEMPTS" },
        { type: "LOG_CALLBACK_REQUEST" },
        { type: "CALLBACK_ACKNOWLEDGED" },
      ]);
    });

    it("from simultaneous DIALING -> DONE callback_requested with cancel/log/ack commands", () => {
      const start = reduceRingPlan(null, {
        type: "START",
        strategy: "simultaneous",
        numbers: ["+61400000001", "+61400000002"],
      });
      const result = reduceRingPlan(start.state, { type: "CALLBACK_STAR_PRESSED" });
      expect(result.state).toEqual({ name: "DONE", outcome: "callback_requested" });
      expect(result.commands).toEqual([
        { type: "CANCEL_OTHER_ATTEMPTS" },
        { type: "LOG_CALLBACK_REQUEST" },
        { type: "CALLBACK_ACKNOWLEDGED" },
      ]);
    });
  });

  describe("terminal / invalid-start guards", () => {
    it("DONE + any event throws", () => {
      const done: RingPlanState = { name: "DONE", outcome: "bridged" };
      expect(() => reduceRingPlan(done, { type: "ATTEMPT_ANSWERED" })).toThrow();
      expect(() => reduceRingPlan(done, { type: "ATTEMPT_FAILED" })).toThrow();
      expect(() => reduceRingPlan(done, { type: "ALL_ATTEMPTS_EXHAUSTED" })).toThrow();
      expect(() => reduceRingPlan(done, { type: "CALLBACK_STAR_PRESSED" })).toThrow();
      expect(() =>
        reduceRingPlan(done, { type: "START", strategy: "cascade", numbers: ["+61400000001"] })
      ).toThrow();
    });

    it("null state + any non-START event throws", () => {
      expect(() => reduceRingPlan(null, { type: "ATTEMPT_ANSWERED" })).toThrow();
      expect(() => reduceRingPlan(null, { type: "ATTEMPT_FAILED" })).toThrow();
      expect(() => reduceRingPlan(null, { type: "ALL_ATTEMPTS_EXHAUSTED" })).toThrow();
      expect(() => reduceRingPlan(null, { type: "CALLBACK_STAR_PRESSED" })).toThrow();
    });
  });
});

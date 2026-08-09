import { describe, expect, it } from "vitest";
import { resolveRingTargets } from "../../src/dial/ringQueue";
import type { StaffRingEntry } from "../../src/db/settings";

describe("resolveRingTargets", () => {
  const mixedList: StaffRingEntry[] = [
    { label: "Phill (mobile)", number: "+61400000000", isOnCall: true },
    { label: "Backup", number: "+61400000001", isOnCall: false },
    { label: "No isOnCall field", number: "+61400000002" },
  ];

  it('target:"all" returns every number regardless of isOnCall', () => {
    expect(resolveRingTargets("all", mixedList)).toEqual([
      "+61400000000",
      "+61400000001",
      "+61400000002",
    ]);
  });

  it('target:"on_call_only" returns only entries where isOnCall === true', () => {
    expect(resolveRingTargets("on_call_only", mixedList)).toEqual(["+61400000000"]);
  });

  it('target:"on_call_only" with zero on-call entries returns [] (not an error, not undefined)', () => {
    const noneOnCall: StaffRingEntry[] = [
      { label: "Backup", number: "+61400000001", isOnCall: false },
      { label: "No isOnCall field", number: "+61400000002" },
    ];
    const result = resolveRingTargets("on_call_only", noneOnCall);
    expect(result).toEqual([]);
    expect(result).not.toBeUndefined();
  });

  it("empty ringList input returns [] for both targets", () => {
    expect(resolveRingTargets("all", [])).toEqual([]);
    expect(resolveRingTargets("on_call_only", [])).toEqual([]);
  });

  it("an entry with isOnCall omitted (undefined, not false) is treated as NOT on-call", () => {
    const list: StaffRingEntry[] = [{ label: "No isOnCall field", number: "+61400000002" }];
    expect(resolveRingTargets("on_call_only", list)).toEqual([]);
  });
});

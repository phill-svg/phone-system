import { transferTargets } from "../src/lib/transfer";

const entry = (email: string) => ({ email, role: "staff" as const, status: "available" as const });

describe("transferTargets", () => {
  // /api/staff returns the whole team including the requester; dialling your own softphone into your
  // own call is never a transfer.
  it("leaves out the person transferring, whatever the case of their stored email", () => {
    const roster = [entry("Phill@tcb.com.au"), entry("sam@tcb.com.au")];
    expect(transferTargets(roster, "phill@tcb.com.au").map((s) => s.email)).toEqual(["sam@tcb.com.au"]);
  });

  it("lists everyone when the requester is not known yet", () => {
    const roster = [entry("a@tcb.com.au"), entry("b@tcb.com.au")];
    expect(transferTargets(roster, undefined)).toHaveLength(2);
  });
});

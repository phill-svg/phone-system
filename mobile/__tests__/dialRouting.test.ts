/// <reference types="jest" />
/// <reference types="node" />
import fs from "fs";
import path from "path";

// "Call via my mobile" shipped wired into only two of the four places you can start a call, so
// ringing someone back from Recents quietly went out over VoIP and the staff member's mobile never
// rang. The claim that every dial went through placeCall() was true of the code I had changed and
// false of the app -- nothing enforced it. This does.
//
// Any screen that navigates to the in-call screen is choosing VoIP. That is only correct for a call
// that is ALREADY on a VoIP leg; a user-initiated outbound dial must go through placeCall(), which
// is what reads the toggle.
const APP_DIR = path.join(__dirname, "..", "src", "app");

const ALLOWED = new Map<string, string>([
  ["call-active.tsx", "is the in-call screen itself"],
  ["call-incoming.tsx", "answers an INBOUND call, which is always a VoIP leg"],
  ["transfer.tsx", "completes a mid-call transfer, which must stay on the existing VoIP leg"],
]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

describe("dial routing", () => {
  it("routes every user-initiated dial through placeCall(), not straight to the in-call screen", () => {
    const offenders = walk(APP_DIR)
      .filter((file) => /["'`]\/call-active["'`]|pathname:\s*["'`]\/call-active["'`]/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .filter((base) => !ALLOWED.has(base));

    expect(offenders).toEqual([]);
  });

  // An allowlist that silently outlives the files it exempts is how the next dial site slips
  // through. call-active.tsx is the screen itself and never navigates to itself, so it is exempt
  // from this half.
  it("keeps the allowlist honest — every exempt navigator still exists and still navigates there", () => {
    const navigating = new Set(
      walk(APP_DIR)
        .filter((file) => /\/call-active/.test(fs.readFileSync(file, "utf8")))
        .map((file) => path.basename(file))
    );
    for (const file of [...ALLOWED.keys()].filter((f) => f !== "call-active.tsx")) {
      expect({ file, navigates: navigating.has(file) }).toEqual({ file, navigates: true });
    }
    expect(fs.existsSync(path.join(APP_DIR, "call-active.tsx"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// The "Outcome" row on the web call detail read `humanize(c.ivr_path)`, and ivr_path holds an IVR
// NODE ID. Production node ids are generated, so a real bridged call displayed:
//
//     Outcome    N 5frbzxd
//
// Reported as "what is the outcome its a bunch of random letters". It only ever looked like prose
// because the seeded test flows use readable ids ("main_ring" -> "Main Ring"), which is exactly the
// shape of bug that survives a test suite: every existing assertion used a friendly id.
//
// So these tests use a REAL generated id, and assert on what the user is shown rather than on the
// implementation. The functions live inside a template literal, so they are extracted from the
// emitted script and rebuilt -- testing what the browser actually receives, not a copy.
function browserFns(): { outcomeLabel: (c: unknown) => string; subLabel: (c: unknown) => string } {
  const html = renderPhonePage("phill@b.com");
  // Pull the three interdependent helpers out of the emitted <script> by name and rebuild them in
  // one scope. Reading them from the page rather than restating them is the point: a regression in
  // phone.ts has to reach this test.
  const needed = ["isMissed", "humanize", "outcomeLabel", "subLabel"];
  const sources = needed.map((name) => {
    const m = new RegExp(`(function ${name}\\(\\w*\\) \\{[\\s\\S]*?\\n      \\})`).exec(html);
    if (!m) throw new Error(`could not find ${name}() in the emitted phone script`);
    return m[1];
  });
  const factory = new Function(`${sources.join("\n")}\nreturn { outcomeLabel: outcomeLabel, subLabel: subLabel };`);
  return factory() as ReturnType<typeof browserFns>;
}

// A generated node id, as the live `main` flow actually contains. The old code turned this into
// "N 5frbzxd" and showed it as the call's outcome.
const NODE_ID = "n_5frbzxd";

const call = (over: Record<string, unknown> = {}) => ({
  direction: "inbound",
  status: "completed",
  ivr_path: NODE_ID,
  answered: 0,
  event_count: 4,
  mailbox_label: null,
  ...over,
});

describe("the web call detail's Outcome field", () => {
  const { outcomeLabel, subLabel } = browserFns();

  // The actual defect: an internal identifier must never reach the screen, whatever the call did.
  it("never shows the raw IVR node id", () => {
    const shapes = [
      call({ answered: 1 }),
      call({ mailbox_label: "Voicemail during hours" }),
      call({ answered: 0, event_count: 4 }),
      call({ status: "in_progress" }),
      call({ direction: "outbound" }),
      call({ event_count: 0, status: "no_answer" }),
    ];
    for (const c of shapes) {
      expect(outcomeLabel(c)).not.toContain("5frbzxd");
      expect(outcomeLabel(c)).not.toMatch(/^N /);
      expect(subLabel(c)).not.toContain("5frbzxd");
    }
  });

  it("says what actually happened", () => {
    expect(outcomeLabel(call({ answered: 1 }))).toBe("Answered");
    expect(outcomeLabel(call({ answered: 0 }))).toBe("Missed call");
    expect(outcomeLabel(call({ mailbox_label: "Voicemail during hours" }))).toBe("Voicemail");
    expect(outcomeLabel(call({ status: "in_progress" }))).toBe("In progress");
    expect(outcomeLabel(call({ direction: "outbound" }))).toBe("Outgoing call");
  });

  // A voicemail can carry an 'answered' event and still be a voicemail: on an AMD fallthrough the
  // staff member's CARRIER voicemail answers the divert leg (writing 'answered'), and the caller is
  // then redirected to business voicemail. Labelling that "Answered" would tell whoever is reading
  // Recents that someone spoke to the customer.
  it("prefers Voicemail over Answered when a call reached a mailbox after being picked up", () => {
    expect(outcomeLabel(call({ answered: 1, mailbox_label: "Voicemail during hours" }))).toBe("Voicemail");
  });

  // An outcome is not a status. A call still ringing has no outcome yet, and saying "Missed" while
  // the phone is in someone's hand is worse than saying nothing.
  it("does not call a live call missed", () => {
    expect(outcomeLabel(call({ status: "in_progress", answered: 0 }))).toBe("In progress");
  });
});

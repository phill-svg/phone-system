import { messageTimeLabel } from "../src/lib/conversations";

// A thread with no times cannot answer "did we reply before they rang?" -- the question staff have
// when they open one.
//
// `now` is passed in rather than mocked: `process.env.TZ` does nothing in this runner (a lesson
// already recorded here), so every assertion is built from real Date objects in the ambient zone
// instead of hard-coded strings that only hold in one timezone.

const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).getTime();

describe("messageTimeLabel", () => {
  const now = at(2026, 8, 22, 14, 30); // 22 Sep 2026, 2:30pm

  it("shows just the time for a message from today", () => {
    const label = messageTimeLabel(at(2026, 8, 22, 9, 5), now);
    expect(label).toMatch(/^9:05\s?(am|a\.m\.)$/i);
    expect(label).not.toMatch(/sep/i);
  });

  it("names yesterday rather than printing a date", () => {
    expect(messageTimeLabel(at(2026, 8, 21, 16, 45), now)).toMatch(/^Yesterday /);
  });

  // The year on every bubble of a conversation held this month is noise.
  it("gives a day and month within the same year, without the year", () => {
    const label = messageTimeLabel(at(2026, 8, 12, 8, 0), now);
    expect(label).toMatch(/12 Sep/);
    expect(label).not.toContain("2026");
  });

  // Older than that, the year is the thing you are looking for.
  it("includes the year once the message is from a different one", () => {
    expect(messageTimeLabel(at(2025, 11, 24, 10, 0), now)).toContain("2025");
  });

  // Midnight is the boundary that matters: 11:59pm and 12:01am are minutes apart and different days.
  it("treats the day boundary as a day boundary, not a 24-hour window", () => {
    const justBeforeMidnight = at(2026, 8, 21, 23, 59);
    const justAfterMidnight = at(2026, 8, 22, 0, 1);
    expect(messageTimeLabel(justBeforeMidnight, now)).toMatch(/^Yesterday /);
    expect(messageTimeLabel(justAfterMidnight, now)).not.toMatch(/Yesterday/);
  });
});

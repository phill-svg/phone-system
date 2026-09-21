// Turning two single-speaker transcripts back into one conversation.
//
// Each channel of the recording is transcribed on its own (see `src/audio/wav.ts` for why we split
// it ourselves), which gives two monologues. This puts them back in the order they were spoken.

// What one channel's transcription gave us. `segments` is optional on purpose: the shape Workers AI
// returns is not something this code should depend on, and a model that stops returning timings
// must degrade to a readable transcript rather than an empty one.
export type ChannelResult = {
  text: string;
  segments?: { start?: unknown; text?: unknown }[];
};

export type LabelledTurn = { who: "Customer" | "Staff"; text: string };

function usableSegments(result: ChannelResult): { start: number; text: string }[] | null {
  if (!Array.isArray(result.segments) || result.segments.length === 0) return null;
  const out: { start: number; text: string }[] = [];
  for (const segment of result.segments) {
    // A segment without a NUMERIC start cannot be ordered, and ordering is the entire purpose.
    // One bad segment discards the timings for that channel rather than silently dropping speech
    // out of sequence -- the block form below still carries every word.
    if (typeof segment?.start !== "number" || !Number.isFinite(segment.start)) return null;
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (text) out.push({ start: segment.start, text });
  }
  return out.length > 0 ? out : null;
}

// The conversation, in order, as turns. Consecutive segments from the same speaker are joined:
// one line per Whisper segment turns a two-minute call into forty fragments and reads worse than
// the unlabelled blob this replaces.
//
// Falls back to ONE turn per speaker when either channel has no usable timings. That reads as a
// summary of each side rather than a dialogue, but every word is still attributed to the right
// person, which is what was asked for.
export function buildLabelledTurns(customer: ChannelResult, staff: ChannelResult): LabelledTurn[] {
  const customerText = customer.text.trim();
  const staffText = staff.text.trim();
  if (!customerText && !staffText) return [];

  const customerSegments = usableSegments(customer);
  const staffSegments = usableSegments(staff);

  if (!customerSegments || !staffSegments) {
    const turns: LabelledTurn[] = [];
    if (customerText) turns.push({ who: "Customer", text: customerText });
    if (staffText) turns.push({ who: "Staff", text: staffText });
    return turns;
  }

  const all = [
    ...customerSegments.map((s) => ({ ...s, who: "Customer" as const })),
    ...staffSegments.map((s) => ({ ...s, who: "Staff" as const })),
  ].sort((a, b) => a.start - b.start);

  const turns: LabelledTurn[] = [];
  for (const segment of all) {
    const last = turns[turns.length - 1];
    if (last && last.who === segment.who) last.text += " " + segment.text;
    else turns.push({ who: segment.who, text: segment.text });
  }
  return turns;
}

// The stored form, e.g.
//
//   Customer: Hello? I have a rat problem.
//
//   Staff: Yeah no worries, whereabouts are you?
export function formatLabelledTurns(turns: LabelledTurn[]): string {
  return turns.map((t) => `${t.who}: ${t.text}`).join("\n\n");
}

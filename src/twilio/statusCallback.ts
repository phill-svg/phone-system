const TERMINAL_STATUS_MAP: Record<string, string> = {
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled",
};

export function normalizeCallStatus(twilioStatus: string): string | null {
  return TERMINAL_STATUS_MAP[twilioStatus] ?? null;
}

import { ApiError } from "./api";

// Turning a thrown request into words for a person. Pure, so the choice of words is testable; the
// screens only show what these return.

// "Not connected yet" is only true when the server says sending is not configured. Keyed on the
// exact messages, not on a 500: a 500 from anywhere else is a real failure, not a missing link.
const NOT_CONFIGURED: Record<string, string> = {
  "SMS is not configured.": "Messaging turns on once your TCB number is linked for SMS.",
  "Messenger sending is not configured.": "Messenger replies turn on once the Facebook Page is linked.",
};

export function sendFailureAlert(e: unknown): { title: string; message: string } {
  if (e instanceof ApiError) {
    const notConfigured = NOT_CONFIGURED[e.message];
    if (notConfigured) return { title: "Not connected yet", message: `${notConfigured} Your draft is kept.` };
    return { title: "Couldn't send", message: `${e.message} Your draft is kept.` };
  }
  return { title: "Couldn't send", message: "Check your connection and try again. Your draft is kept." };
}

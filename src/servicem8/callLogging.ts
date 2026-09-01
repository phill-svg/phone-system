import { findMostRecentJobByPhone, addJobNote } from "./client";

export type LoggableCall = {
  direction: "inbound" | "outbound";
  callerNumber: string;
  calledNumber: string;
  startedAt: number;
  endedAt: number;
  status: string;
};

// Best-effort: matches the customer's number (caller on inbound, callee on outbound) against
// ServiceM8, then drops a diary note on their most recently active job. Silently does nothing when
// there's no match -- an unmatched call (a supplier, a wrong number, a new customer with no job yet)
// is the normal case, not a failure. Only AU numbers are matchable today, same as the phone
// normalization ServiceM8 search expects.
export async function logCallToServiceM8(apiKey: string, call: LoggableCall): Promise<void> {
  const customerNumber = call.direction === "inbound" ? call.callerNumber : call.calledNumber;
  if (!customerNumber?.startsWith("+61")) return;

  const job = await findMostRecentJobByPhone(apiKey, customerNumber);
  if (!job) return;

  const durationSec = Math.max(0, Math.round((call.endedAt - call.startedAt) / 1000));
  const when = new Date(call.startedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
  const dirLabel = call.direction === "inbound" ? "Inbound call from" : "Outbound call to";
  const note = `${dirLabel} ${customerNumber}\n${when} -- ${durationSec}s -- ${call.status}\nLogged automatically by TCB Phone.`;
  await addJobNote(apiKey, job.uuid, note);
}

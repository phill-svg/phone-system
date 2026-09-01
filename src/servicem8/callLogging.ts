import { findMostRecentJobByPhone, addJobNote, findJobContactByPhone } from "./client";
import { findContactByPhone, createContact } from "../db/contacts";

export type LoggableCall = {
  direction: "inbound" | "outbound";
  callerNumber: string;
  calledNumber: string;
  startedAt: number;
  endedAt: number;
  status: string;
};

// The customer's own number: caller on inbound, callee on outbound. Only AU numbers are matchable
// today, same as the phone normalization ServiceM8 expects.
function customerNumberFor(call: LoggableCall): string | null {
  const n = call.direction === "inbound" ? call.callerNumber : call.calledNumber;
  return n?.startsWith("+61") ? n : null;
}

// Best-effort: matches the customer's number against ServiceM8, then drops a diary note on their
// most recently active job. Silently does nothing when there's no match -- an unmatched call (a
// supplier, a wrong number, a new customer with no job yet) is the normal case, not a failure.
export async function logCallToServiceM8(apiKey: string, call: LoggableCall): Promise<void> {
  const customerNumber = customerNumberFor(call);
  if (!customerNumber) return;

  const job = await findMostRecentJobByPhone(apiKey, customerNumber);
  if (!job) return;

  const durationSec = Math.max(0, Math.round((call.endedAt - call.startedAt) / 1000));
  const when = new Date(call.startedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
  const dirLabel = call.direction === "inbound" ? "Inbound call from" : "Outbound call to";
  const note = `${dirLabel} ${customerNumber}\n${when} -- ${durationSec}s -- ${call.status}\nLogged automatically by TCB Phone.`;
  await addJobNote(apiKey, job.uuid, note);
}

// Mirrors the "make contact" Make.com scenario -- there, an unrecognized caller's ServiceM8 job
// contact was used to name them in Aircall. Here, the equivalent is TCB Phone's own `contacts`
// table (the source of caller-ID names across calls, SMS, and call history): when we don't already
// have a name for this number, pull one from ServiceM8 so it auto-fills instead of staying a bare
// number forever. Never overwrites an existing contact -- ServiceM8 only fills in the gaps.
export async function syncContactFromServiceM8(db: D1Database, apiKey: string, call: LoggableCall): Promise<void> {
  const customerNumber = customerNumberFor(call);
  if (!customerNumber) return;

  const existing = await findContactByPhone(db, customerNumber);
  if (existing) return;

  const match = await findJobContactByPhone(apiKey, customerNumber);
  if (!match) return;
  const name = [match.firstName, match.lastName].filter(Boolean).join(" ").trim();
  if (!name) return;

  await createContact(db, { name, phone: customerNumber });
}

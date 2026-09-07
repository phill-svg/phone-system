import {
  searchByPhone,
  pickMostRecentJob,
  pickCustomerName,
  addJobNote,
  findJobContactByPhone,
  type Sm8SearchResult,
} from "./client";
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

// Everything ServiceM8 does for one finished call, off a SINGLE search.
//
// Both halves are best-effort and independent: a note that fails must not stop the contact being
// created, and vice versa. What is NOT optional any more is saying so -- every failure here used
// to be swallowed whole, which is how the integration sat inert without anyone noticing. If you
// are wondering why nothing is being logged, `wrangler tail` and look for SERVICEM8_.
export async function logCallAndSyncContact(db: D1Database, apiKey: string, call: LoggableCall): Promise<void> {
  const customerNumber = customerNumberFor(call);
  if (!customerNumber) return;

  let results: Sm8SearchResult[];
  try {
    results = await searchByPhone(apiKey, customerNumber);
  } catch (e) {
    // The one failure worth shouting about: a missing or revoked API key looks exactly like this,
    // and it takes out both halves at once.
    console.error("SERVICEM8_SEARCH_FAILED", JSON.stringify({ number: customerNumber, error: String(e) }));
    return;
  }

  if (results.length === 0) {
    // An unmatched number (a supplier, a wrong number, a brand-new customer) is the normal case,
    // not a failure -- but logging it is what tells you matching is working at all.
    console.log("SERVICEM8_NO_MATCH", JSON.stringify({ number: customerNumber }));
    return;
  }

  const outcomes = await Promise.allSettled([
    logCallNote(apiKey, results, call, customerNumber),
    syncContact(db, apiKey, results, customerNumber),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      console.error("SERVICEM8_TASK_FAILED", JSON.stringify({ number: customerNumber, error: String(outcome.reason) }));
    }
  }
}

// Drops a diary note on the customer's most recently active job.
async function logCallNote(
  apiKey: string,
  results: Sm8SearchResult[],
  call: LoggableCall,
  customerNumber: string
): Promise<void> {
  const job = pickMostRecentJob(results);
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
async function syncContact(
  db: D1Database,
  apiKey: string,
  results: Sm8SearchResult[],
  customerNumber: string
): Promise<void> {
  const existing = await findContactByPhone(db, customerNumber);
  if (existing) return;

  // The search results already name the customer in the overwhelming majority of cases (the
  // company record IS the customer). jobcontact is only consulted when they don't.
  let name = pickCustomerName(results);
  if (!name) {
    const match = await findJobContactByPhone(apiKey, customerNumber);
    name = match ? [match.firstName, match.lastName].filter(Boolean).join(" ").trim() : null;
  }
  if (!name) {
    console.log("SERVICEM8_NO_NAME", JSON.stringify({ number: customerNumber }));
    return;
  }

  await createContact(db, { name, phone: customerNumber });
  console.log("SERVICEM8_CONTACT_CREATED", JSON.stringify({ number: customerNumber, name }));
}

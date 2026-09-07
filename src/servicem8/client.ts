// ServiceM8 REST API v1 (https://api.servicem8.com/api_1.0). Endpoint paths, auth header, and field
// names below are taken from Phill's existing "aircall - sm8 - create note" Make.com scenario
// (verified working against production ServiceM8 data), not guessed from docs -- ServiceM8's
// developer docs weren't reachable from this environment's network egress.
const SM8_BASE = "https://api.servicem8.com/api_1.0";

export type Sm8SearchResult = {
  type: string;
  uuid: string;
  title: string;
  // The full underlying record (job/company/...) is embedded here, including edit_date -- used
  // below to pick the MOST RECENT matching job rather than just the top search hit, and `name` on
  // a company result, which is the customer's name.
  data?: { edit_date?: string; generated_job_id?: string; status?: string; name?: string; [key: string]: unknown };
};

function sm8Headers(apiKey: string): HeadersInit {
  return { "X-Api-Key": apiKey, Accept: "application/json" };
}

// Same normalization the Make.com scenario uses: AU E.164 -> local 0-prefixed, no spaces.
// ServiceM8's search endpoint tokenizes phone digits regardless of how they're formatted on the
// client record (confirmed in production: a query of "0403981758" matched a record stored as
// "0403 981 758"), so this one form is enough FOR SEARCH. It is not enough for the OData filter
// below, which compares exactly -- see phoneVariants().
function localAuNumber(e164: string): string {
  return e164.replace(/^\+61/, "0");
}

// One search per call, shared by the note and the contact sync. Both used to run their own lookup,
// which doubled the API calls for a single completed call and could disagree with each other.
export async function searchByPhone(apiKey: string, e164: string): Promise<Sm8SearchResult[]> {
  const q = localAuNumber(e164);
  const res = await fetch(`${SM8_BASE}/search.json?q=${encodeURIComponent(q)}&limit=10`, {
    headers: sm8Headers(apiKey),
  });
  if (!res.ok) throw new Error(`ServiceM8 search failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ results?: Sm8SearchResult[] }>();
  return body.results ?? [];
}

// The most recently edited matching Job. Returns null when the number matches no job -- callers
// should treat that as "nothing to log", not an error.
export function pickMostRecentJob(results: Sm8SearchResult[]): { uuid: string; jobNumber: string } | null {
  const jobs = results.filter((r) => r.type === "job");
  if (jobs.length === 0) return null;
  jobs.sort((a, b) => String(b.data?.edit_date ?? "").localeCompare(String(a.data?.edit_date ?? "")));
  // An "Unsuccessful" job (quote declined, job fell through, etc.) shouldn't soak up call notes --
  // prefer the most recent job that's still live. Only fall back to an Unsuccessful one when it's
  // the customer's ONLY matching job, since a note somewhere is better than none.
  const top = jobs.find((j) => j.data?.status !== "Unsuccessful") ?? jobs[0];
  return { uuid: top.uuid, jobNumber: String(top.data?.generated_job_id ?? "") };
}

// "Job #956 - Sue Dunkley" -> "Sue Dunkley". Only used as a fallback when no company record came
// back; anchored so a job titled something else entirely yields nothing rather than a garbage name.
const JOB_TITLE_NAME = /^job\s*#?\d+\s*-\s*(.+)$/i;

// The customer's name for this number, straight out of the search results.
//
// This replaces a second, exact-match lookup against jobcontact.json. Search tokenizes the digits
// and matches however the number is stored ("0402 430 107", "+61402430107"); `mobile eq '...'`
// does not, so a customer whose number carries spaces was invisible to the old path -- the note
// got written and the contact silently never did.
export function pickCustomerName(results: Sm8SearchResult[]): string | null {
  const company = results.find((r) => r.type === "company" && String(r.data?.name ?? "").trim());
  if (company) return String(company.data!.name).trim();
  for (const job of results.filter((r) => r.type === "job")) {
    const match = JOB_TITLE_NAME.exec(job.title.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

// The formats an AU number is plausibly stored in on a ServiceM8 contact record. The OData filter
// below is an exact string compare, so every one we don't send is a customer we don't find.
export function phoneVariants(e164: string): string[] {
  const local = localAuNumber(e164);
  const variants = [local, e164, e164.replace(/^\+/, "")];
  if (/^04\d{8}$/.test(local)) variants.push(`${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`);
  else if (/^0[2378]\d{8}$/.test(local)) variants.push(`${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}`);
  return [...new Set(variants)];
}

type Sm8JobContact = { first?: string; last?: string; mobile?: string; phone?: string };

// Fallback name source: ServiceM8's job-contact records, the way the "make contact" Make.com
// scenario did. Used only when the search results carry no name -- a job can exist under a company
// with no name set, with the person's name only on the job contact.
export async function findJobContactByPhone(apiKey: string, e164: string): Promise<{ firstName: string; lastName: string } | null> {
  // Single quotes are the OData string delimiter; a number never contains one, but a malformed
  // caller ID reaching this unescaped would break the filter rather than just miss.
  const clauses = phoneVariants(e164)
    .map((v) => v.replace(/'/g, "''"))
    .flatMap((v) => [`mobile eq '${v}'`, `phone eq '${v}'`]);
  const res = await fetch(`${SM8_BASE}/jobcontact.json?$filter=${encodeURIComponent(clauses.join(" or "))}&limit=5`, {
    headers: sm8Headers(apiKey),
  });
  if (!res.ok) throw new Error(`ServiceM8 jobcontact lookup failed: ${res.status} ${await res.text()}`);
  const contacts = await res.json<Sm8JobContact[]>();
  const match = (contacts ?? []).find((c) => c.first?.trim());
  if (!match?.first) return null;
  return { firstName: match.first.trim(), lastName: (match.last ?? "").trim() };
}

// Adds a staff diary note to a job. `active`/`action_required` string values ("1"/"0") match what
// ServiceM8's API expects -- confirmed by the working Make.com scenario, which sends the same shape.
export async function addJobNote(apiKey: string, jobUuid: string, note: string): Promise<void> {
  const res = await fetch(`${SM8_BASE}/note.json`, {
    method: "POST",
    headers: { ...sm8Headers(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      related_object: "job",
      related_object_uuid: jobUuid,
      note,
      active: "1",
      action_required: "0",
    }),
  });
  if (!res.ok) throw new Error(`ServiceM8 note create failed: ${res.status} ${await res.text()}`);
}

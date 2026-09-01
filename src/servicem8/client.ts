// ServiceM8 REST API v1 (https://api.servicem8.com/api_1.0). Endpoint paths, auth header, and field
// names below are taken from Phill's existing "aircall - sm8 - create note" Make.com scenario
// (verified working against production ServiceM8 data), not guessed from docs -- ServiceM8's
// developer docs weren't reachable from this environment's network egress.
const SM8_BASE = "https://api.servicem8.com/api_1.0";

type Sm8SearchResult = {
  type: string;
  uuid: string;
  title: string;
  // The full underlying record (job/company/...) is embedded here for a "job" result, including
  // edit_date -- used below to pick the MOST RECENT matching job rather than just the top search hit.
  data?: { edit_date?: string; generated_job_id?: string; [key: string]: unknown };
};

function sm8Headers(apiKey: string): HeadersInit {
  return { "X-Api-Key": apiKey, Accept: "application/json" };
}

// Same normalization the Make.com scenario uses: AU E.164 -> local 0-prefixed, no spaces.
// ServiceM8's search endpoint tokenizes phone digits regardless of how they're formatted on the
// client record (confirmed in production: a query of "0403981758" matched a record stored as
// "0403 981 758"), so this one form is enough.
function localAuNumber(e164: string): string {
  return e164.replace(/^\+61/, "0");
}

// Finds the most recently edited Job whose record matches this phone number, via ServiceM8's
// global search endpoint (the same one the Aircall Make.com scenario uses). Returns null if there's
// no job match -- callers should treat that as "nothing to log", not an error.
export async function findMostRecentJobByPhone(apiKey: string, e164: string): Promise<{ uuid: string; jobNumber: string } | null> {
  const q = localAuNumber(e164);
  const res = await fetch(`${SM8_BASE}/search.json?q=${encodeURIComponent(q)}&limit=10`, {
    headers: sm8Headers(apiKey),
  });
  if (!res.ok) throw new Error(`ServiceM8 search failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ results?: Sm8SearchResult[] }>();
  const jobs = (body.results ?? []).filter((r) => r.type === "job");
  if (jobs.length === 0) return null;
  jobs.sort((a, b) => String(b.data?.edit_date ?? "").localeCompare(String(a.data?.edit_date ?? "")));
  const top = jobs[0];
  return { uuid: top.uuid, jobNumber: String(top.data?.generated_job_id ?? "") };
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

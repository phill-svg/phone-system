import type { ServiceM8LookupPage, ServiceM8Match } from "./api";

// Admin > Sync Contacts. The server checks 15 unsaved numbers per request (on the Workers free
// plan one request may make 50 outside fetches), so this asks again with the cursor until there is
// nothing left. The same rule as `lookupAllInServiceM8` in the web Phone page; change both.
// The page fetcher is a parameter so this file stays free of the network and testable.
export async function lookupAllInServiceM8(
  fetchPage: (after: string | null) => Promise<ServiceM8LookupPage>,
  onProgress: (done: number, total: number) => void
): Promise<{ matches: ServiceM8Match[]; failed: number; checked: number }> {
  let matches: ServiceM8Match[] = [];
  let failed = 0;
  let checked = 0;
  let after: string | null = null;
  for (;;) {
    const data = await fetchPage(after);
    matches = matches.concat(data.matches);
    failed += data.failed;
    checked += data.checked;
    onProgress(checked, checked + data.remaining);
    if (!data.next) break;
    // A cursor that does not move would search ServiceM8 forever.
    if (data.next === after) throw new Error("ServiceM8 lookup stopped making progress.");
    after = data.next;
  }
  return { matches, failed, checked };
}

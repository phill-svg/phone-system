import { jsonResponse } from "./respond";
import { listUnnamedFacebookPsids, upsertFacebookName } from "../db/fbContacts";
import { lookupFacebookName } from "../facebook/graph";

// Retry the Graph API name lookup for every Messenger sender still showing as "Facebook user".
// Inbound messages resolve a name once and then never try again, so a spell of failed lookups (an
// expired Page token is the usual one) leaves those conversations nameless forever. This is the
// button that fixes them once the token is good again — and, when it still isn't, the one place
// that says out loud what Facebook is objecting to.
export async function handleResolveFacebookNames(db: D1Database, token?: string): Promise<Response> {
  if (!token) {
    return jsonResponse({ error: "Facebook name lookup isn't set up: the FB_PAGE_ACCESS_TOKEN secret is missing." }, 400);
  }
  const psids = await listUnnamedFacebookPsids(db);
  const resolved: string[] = [];
  const failed: { psid: string; error: string }[] = [];
  for (const psid of psids) {
    const result = await lookupFacebookName(psid, token);
    if ("name" in result) {
      await upsertFacebookName(db, psid, result.name);
      resolved.push(result.name);
    } else {
      failed.push({ psid, error: result.error });
    }
  }
  return jsonResponse({ checked: psids.length, resolved, failed });
}

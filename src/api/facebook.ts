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

// Save a name for one Messenger sender by hand. The Graph API lookup is best-effort and can fail
// for good (an expired Page token, a PSID this token cannot read) — when it does, staff still need
// to know who they are talking to, so let them type the name once. It is stored in exactly the
// place the Graph lookup would have written it, so the inbox, the thread and the push notification
// all pick it up, and a later successful lookup simply overwrites it.
export async function handleSetFacebookName(request: Request, db: D1Database): Promise<Response> {
  let body: { psid?: unknown; name?: unknown };
  try {
    body = (await request.json()) as { psid?: unknown; name?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  // Accept either the raw psid or the "messenger:<psid>" peer id the UI already holds.
  const psid = String(body.psid ?? "").trim().replace(/^messenger:/, "");
  const name = String(body.name ?? "").trim().slice(0, 100);
  if (!psid) return jsonResponse({ error: "Which Facebook sender?" }, 400);
  if (!name) return jsonResponse({ error: "Enter a name." }, 400);
  await upsertFacebookName(db, psid, name);
  return jsonResponse({ ok: true, psid, name });
}

// Diagnostic: what CAN this Page token see?
//
// The User Profile API (GET /<psid>?fields=name) returns code 100 "cannot be loaded due to missing
// permissions" for anyone without a role on the Page, because the app's pages_messaging is still
// "ready for testing" (Standard Access). This probe checks a different route to the same names:
// the Page's own conversation list, which is the Page owner's data rather than a stranger's
// profile, and returns participant names inline. If that works, names resolve with no App Review.
export async function handleFacebookProbe(env: {
  FB_PAGE_ACCESS_TOKEN?: string;
  TWILIO_MESSENGER_FROM?: string;
}): Promise<Response> {
  const token = env.FB_PAGE_ACCESS_TOKEN;
  if (!token) return jsonResponse({ error: "FB_PAGE_ACCESS_TOKEN is not set" }, 400);
  const pageId = (env.TWILIO_MESSENGER_FROM ?? "").replace(/^messenger:/, "");

  async function probe(label: string, path: string) {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token!)}`);
      const text = await res.text();
      return { label, status: res.status, body: text.slice(0, 1500) };
    } catch (e) {
      return { label, status: 0, body: String(e) };
    }
  }

  return jsonResponse({
    pageId,
    probes: [
      // Who does this token actually belong to?
      await probe("token identity", "me?fields=id,name"),
      // The Page inbox, with participant names -- the route that may not need App Review.
      await probe("page conversations", `${pageId}/conversations?platform=messenger&fields=participants,updated_time&limit=10`),
    ],
  });
}

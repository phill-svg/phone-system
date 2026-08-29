// Facebook Graph API lookup for a Messenger sender's display name.
//
// This is the one call that turns "messenger:<psid>" into a person's name, and it fails silently
// in production far too easily: a Page access token expires (a token minted from a short-lived
// user token dies within the hour), the Page's app loses pages_messaging, or the PSID isn't one
// this token can read. So the lookup reports WHY it failed — the webhook logs it and the manual
// refresh shows it in the dashboard — instead of leaving the inbox showing a raw id with no clue.

export type FacebookNameLookup = { name: string } | { error: string };

// Graph errors come back as {"error":{"message":...,"type":"OAuthException","code":190}} — the
// message is the useful half ("Error validating access token: Session has expired…").
type GraphResponse = { name?: string; error?: { message?: string; type?: string; code?: number } };

export async function lookupFacebookName(psid: string, token: string): Promise<FacebookNameLookup> {
  let res: Response;
  try {
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(psid)}?fields=name&access_token=${encodeURIComponent(token)}`;
    res = await fetch(url);
  } catch (e) {
    return { error: `Could not reach the Facebook Graph API: ${String(e)}` };
  }
  let data: GraphResponse | null = null;
  try {
    data = (await res.json()) as GraphResponse;
  } catch {
    data = null;
  }
  if (data?.name) return { name: data.name };
  const err = data?.error;
  if (err?.message) return { error: `${err.type ?? "GraphError"} ${err.code ?? res.status}: ${err.message}` };
  if (!res.ok) return { error: `Facebook returned HTTP ${res.status}.` };
  return { error: "Facebook returned no name for this person." };
}

// Name-or-null wrapper for the inbound webhook, which has nowhere to show an error — it logs the
// reason instead, so `wrangler tail` says whether the token is dead or the PSID is unreadable.
export async function resolveFacebookName(psid: string, token: string): Promise<string | null> {
  const result = await lookupFacebookName(psid, token);
  if ("name" in result) return result.name;
  console.warn(`Facebook name lookup failed for psid ${psid}: ${result.error}`);
  return null;
}

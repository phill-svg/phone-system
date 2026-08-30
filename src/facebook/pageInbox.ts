// Resolve Messenger sender names from the PAGE'S OWN INBOX, not from each sender's profile.
//
// Why this exists: GET /<psid>?fields=name (the User Profile API) returns
//   "code 100: Unsupported get request ... cannot be loaded due to missing permissions"
// for anyone who does not hold a role on the Page, because the app's pages_messaging sits at
// Standard Access ("ready for testing"). Advanced Access needs App Review + Business Verification.
//
// GET /<page-id>/conversations?fields=participants asks a different question -- "who is in my own
// inbox?" -- which is the Page owner's own data, and it answers with every participant's name and
// PSID. Verified against the live Page: it returns the very sender the profile lookup refuses.
// One call names every open thread, so this is both the permitted route and the cheaper one.

export type PageInboxNames = { names: Map<string, string> } | { error: string };

type Participant = { id?: string; name?: string };
type Conversation = { participants?: { data?: Participant[] } };
type ConversationsPage = {
  data?: Conversation[];
  paging?: { next?: string };
  error?: { message?: string; type?: string; code?: number };
};

// Follow at most this many pages of the inbox. Each page is 100 threads, so this covers 500
// conversations -- far more than we need to name the handful with recent messages, while keeping
// a busy Page from turning one cron tick into an unbounded crawl.
const MAX_PAGES = 5;

export async function fetchPageInboxNames(pageId: string, token: string): Promise<PageInboxNames> {
  if (!pageId) return { error: "No Facebook Page id configured (TWILIO_MESSENGER_FROM)." };
  const names = new Map<string, string>();
  let url =
    `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/conversations` +
    `?platform=messenger&fields=participants&limit=100&access_token=${encodeURIComponent(token)}`;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    let body: ConversationsPage;
    try {
      const res = await fetch(url);
      body = (await res.json()) as ConversationsPage;
      if (!res.ok || body.error) {
        const err = body.error;
        return {
          error: err?.message
            ? `${err.type ?? "GraphError"} ${err.code ?? res.status}: ${err.message}`
            : `Facebook returned HTTP ${res.status} for the Page inbox.`,
        };
      }
    } catch (e) {
      return { error: `Could not reach the Facebook Graph API: ${String(e)}` };
    }

    for (const convo of body.data ?? []) {
      for (const p of convo.participants?.data ?? []) {
        // Every thread lists the Page itself as a participant -- that is us, not a customer.
        if (!p.id || !p.name || p.id === pageId) continue;
        if (!names.has(p.id)) names.set(p.id, p.name);
      }
    }
    url = body.paging?.next ?? "";
  }
  return { names };
}

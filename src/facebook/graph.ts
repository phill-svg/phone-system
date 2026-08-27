// Facebook Graph API lookup for a Messenger sender's display name. Never throws -- a failed
// lookup just means the inbox keeps showing the raw messenger:<psid> id, which is a fine
// degrade for a best-effort name resolution.
export async function resolveFacebookName(psid: string, token: string): Promise<string | null> {
  try {
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(psid)}?fields=name&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string };
    return data.name || null;
  } catch {
    return null;
  }
}

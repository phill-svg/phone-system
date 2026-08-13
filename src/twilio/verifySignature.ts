function buildSignedMessage(url: string, params: Record<string, string>): string {
  const sortedConcat = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return url + sortedConcat;
}

async function computeSignature(authToken: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string,
  authTokens: (string | undefined)[]
): Promise<boolean> {
  const candidates = authTokens.filter((token): token is string => !!token);
  if (candidates.length === 0) {
    return false;
  }
  try {
    const message = new TextEncoder().encode(buildSignedMessage(url, params));
    for (const token of candidates) {
      const computed = await computeSignature(token, message);
      if (computed === signatureHeader) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

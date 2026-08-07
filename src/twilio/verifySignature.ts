function buildSignedMessage(url: string, params: Record<string, string>): string {
  const sortedConcat = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return url + sortedConcat;
}

export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string,
  authToken: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const message = new TextEncoder().encode(buildSignedMessage(url, params));
    const signature = await crypto.subtle.sign("HMAC", key, message);
    const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return computed === signatureHeader;
  } catch {
    return false;
  }
}

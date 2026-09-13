export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A URL path segment, decoded -- or null for a malformed escape ("%E0%A4%A"), on which
// decodeURIComponent throws URIError. Every route param goes through this and 404s on null, so a
// junk URL can never surface as an unhandled 500.
export function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

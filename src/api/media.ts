// Public, unauthenticated media route: Twilio's servers fetch this URL directly to
// play audio over a live phone call and cannot present any Cloudflare Access credential.
// This handler MUST NOT be gated by requireStaffUser — see src/worker.ts routing.
export async function handleGetMedia(bucket: R2Bucket, key: string): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    return new Response("not found", { status: 404 });
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

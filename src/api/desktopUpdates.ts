// Serves the desktop app's auto-update feed out of R2.
//
// electron-updater fetches `latest.yml`, then the installer and its .blockmap, from a plain HTTP
// URL. It cannot authenticate the way the dashboard does, so this route is deliberately public --
// the installer is a thin Electron shell around a login-gated dashboard and carries no secrets.
//
// It reads from the same bucket as the IVR audio assets, so the key is built from a validated
// basename under a fixed `desktop/` prefix. Without that guard, a crafted filename could walk out
// of the prefix and hand out customer call recordings and voicemail greetings to anyone.

const UPDATE_PREFIX = "desktop/";

// Deliberately strict: letters, digits, dot, dash, underscore. No slashes, so no traversal, and
// no percent-encoding to decode our way back into one.
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function contentTypeFor(filename: string): string {
  if (filename.endsWith(".yml") || filename.endsWith(".yaml")) return "text/yaml; charset=utf-8";
  if (filename.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export async function handleDesktopUpdateAsset(bucket: R2Bucket, filename: string): Promise<Response> {
  if (!SAFE_FILENAME.test(filename) || filename.includes("..")) {
    return new Response("not found", { status: 404 });
  }

  const object = await bucket.get(UPDATE_PREFIX + filename);
  if (!object) return new Response("not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": contentTypeFor(filename),
      "Content-Length": String(object.size),
      "ETag": object.httpEtag,
      // latest.yml is polled every few hours and must not be served stale from an edge cache;
      // the installers are immutable per version, so they can be cached hard.
      "Cache-Control": filename.endsWith(".yml") ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

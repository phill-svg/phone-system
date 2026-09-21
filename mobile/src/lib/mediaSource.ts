import { useEffect, useState } from "react";
import { BASE_URL } from "./api";
import { getToken } from "./session";

// The path the worker serves one attachment from. Kept beside the type it belongs to rather than
// built inline at the call site, so the route and the client cannot drift.
export function messageMediaPath(messageId: string, idx: number): string {
  return `/api/messages/${encodeURIComponent(messageId)}/media/${idx}`;
}

export type ImageSource = { uri: string; headers: Record<string, string> };

// An `<Image source>` for an attachment behind the staff session.
//
// The media route is staff-gated, like every other `/api/` route, and React Native's Image does not
// carry the app's session on its own -- so without the header it fetches as an anonymous request
// and renders nothing, with no error anywhere. The token comes from SecureStore, which is async,
// so this is a hook rather than a function: null until it resolves, and the caller shows nothing
// rather than a broken image.
//
// The token is NOT put in the URL. A query-string credential ends up in logs, in caches, and in
// anything that records a URL.
export function useMediaSource(path: string | null): ImageSource | null {
  const [source, setSource] = useState<ImageSource | null>(null);
  useEffect(() => {
    let alive = true;
    if (!path) {
      setSource(null);
      return;
    }
    getToken()
      .then((token) => {
        // Signed out between render and resolve: show nothing rather than an anonymous request
        // that renders as a broken image.
        if (!alive || !token) return;
        setSource({ uri: `${BASE_URL}${path}`, headers: { Authorization: `Bearer ${token}` } });
      })
      .catch(() => {
        // getToken waits for the keychain to become readable on a locked phone and can refuse.
        // Nothing to show is the honest outcome; the thread text is unaffected.
        if (alive) setSource(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);
  return source;
}

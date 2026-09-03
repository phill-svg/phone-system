import { jsonResponse } from "../api/respond";
import { demoCall, demoCalls, demoContacts, demoConversations, demoThread } from "./fixtures";

// The App Review demo account is served invented data instead of the real business inbox, because
// conversations, calls and contacts here are business-wide: any login sees real customers by name
// and number. See fixtures.ts for the data and the reasoning.
//
// This is a READ substitution plus a WRITE sink. Outbound calling is deliberately NOT touched --
// the softphone token endpoint is untouched, so a reviewer can place a real call and verify the
// app's central claim. Blocking that would invite a "we could not test the core functionality"
// rejection, which is far more likely than any harm from one test call.

type DemoEnv = { DEMO_ACCOUNT_EMAILS?: string };

export function isDemoUser(email: string, env: DemoEnv): boolean {
  const configured = (env.DEMO_ACCOUNT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(email.trim().toLowerCase());
}

// Returns a Response for any request the demo account must not see real data through, or null to
// let the request fall through to the normal handlers.
//
// Anything NOT matched here is genuinely harmless for a reviewer to reach: /api/me, /api/numbers
// (the business's own published numbers), the softphone token, and per-user settings, which write
// only that reviewer's own row.
export function handleDemoRequest(
  url: URL,
  request: Request,
  now: number = Date.now()
): Response | null {
  const method = request.method;

  if (url.pathname === "/api/messages") {
    // A reviewer tapping Send must not dispatch a real SMS or Messenger reply. Report success so
    // the app behaves normally; the message simply is not persisted, and a refresh restores the
    // fixture thread.
    if (method === "POST") return jsonResponse({ ok: true });
    return jsonResponse(demoConversations(now));
  }

  const threadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (threadMatch) {
    return jsonResponse(demoThread(now, decodeURIComponent(threadMatch[1])));
  }

  if (url.pathname === "/api/calls") {
    return jsonResponse(demoCalls(now));
  }

  // Matched before the /api/calls/:id rule below, which would otherwise treat "live" as a call id
  // and 404 the live-calls poll. Nothing is live in the demo, so the honest answer is an empty list.
  if (url.pathname === "/api/calls/live") {
    return jsonResponse([]);
  }

  // Demo calls carry no recording, so the player never appears and this only guards a direct hit.
  if (/^\/api\/calls\/[^/]+\/recording$/.test(url.pathname)) {
    return new Response("not found", { status: 404 });
  }

  const callMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
  if (callMatch) {
    // Notes and disposition are editable on a call; swallow the write rather than let a reviewer
    // annotate a record that does not exist.
    if (method !== "GET") return jsonResponse({ ok: true });
    const call = demoCall(now, decodeURIComponent(callMatch[1]));
    return call ? jsonResponse(call) : jsonResponse({ error: "not found" }, 404);
  }

  if (url.pathname === "/api/contacts" || /^\/api\/contacts\/\d+$/.test(url.pathname) || url.pathname === "/api/contacts/import") {
    if (method !== "GET") return jsonResponse({ ok: true });
    return jsonResponse(demoContacts(now));
  }

  // No real caller ever waits on a demo callback list.
  if (url.pathname === "/api/callback-requests") {
    return jsonResponse([]);
  }

  return null;
}

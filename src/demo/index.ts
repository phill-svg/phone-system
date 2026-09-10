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

export function demoEmails(env: DemoEnv): string[] {
  return (env.DEMO_ACCOUNT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// The ONE place the demo account is filtered out of a staff list.
//
// This existed as three byte-identical copies (the ungated roster, the ring-target resolver, and
// the on-call pickers), and the surface that skipped it is exactly where the bug turned up: Health
// Checks reported "reviewer is on call, ringing +61..." over a rotation that rings nobody, because
// resolveRingTargets drops the account at dial time and the check read the unfiltered list. Four
// copies would have meant a fourth chance to miss one.
export function excludeDemos<T extends { email: string }>(roster: T[], env: DemoEnv): T[] {
  return excludeEmails(roster, demoEmails(env));
}

// The list-taking primitive, for the two callers that are already handed `demoEmails(env)` from
// higher up rather than the env itself.
export function excludeEmails<T extends { email: string }>(roster: T[], emails: string[]): T[] {
  const excluded = new Set(emails.map((e) => e.trim().toLowerCase()));
  return roster.filter((s) => !excluded.has(s.email.trim().toLowerCase()));
}

export function isDemoUser(email: string, env: DemoEnv): boolean {
  const address = email.trim().toLowerCase();
  return address.length > 0 && demoEmails(env).includes(address);
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

  // No real caller ever waits on a demo callback list -- and a reviewer ticking one off must not
  // reach a real request, so the mark-done/reopen write is swallowed like every other demo write.
  if (url.pathname === "/api/callback-requests" || /^\/api\/callback-requests\/\d+$/.test(url.pathname)) {
    if (method !== "GET") return jsonResponse({ ok: true });
    return jsonResponse([]);
  }

  return null;
}

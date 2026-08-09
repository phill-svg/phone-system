# Homepage redirect — design

## Problem

The worker has no route for `/`. Hitting the bare domain returns a plain 404, giving staff no obvious way into the admin dashboard. The three real admin pages (`/admin/live`, `/admin/calls`, `/admin/settings`) already share a nav shell (`src/html/layout.ts`), but nothing points a visitor at any of them.

## Scope

This spec covers only the `/` route. It does not cover:
- Cloudflare Access configuration (tracked separately — `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` are currently blank in `wrangler.jsonc`, so `/admin/*` fails closed with "auth misconfigured" in production until that's set up).
- The Electron desktop app (separate design, follows this one).

## Design

Add one route in `src/worker.ts`, checked before the existing `/admin/` and `/api/` blocks:

- `GET /` → `302` redirect to `/admin/live`, via `Response.redirect(new URL("/admin/live", request.url), 302)`.

No new HTML page. No new auth logic — `/admin/live` already requires a valid staff session via `requireStaffUser` (`src/access/requireStaffUser.ts`), so the redirect doesn't bypass or duplicate that gate. A stranger hitting `/` gets bounced to `/admin/live` and then blocked there (401/403 today; Cloudflare's Access login prompt once Access is configured).

`/admin` (no trailing content) is left untouched — it already falls through to the final `return new Response("not found", { status: 404 })` in `worker.ts`, since only `/admin/` (with trailing slash) is matched by `startsWith`. That 404 is the desired, existing behavior.

## Testing

One test added to `test/worker.test.ts`, following the existing `describe`/`it` structure used for other routes:

- `GET /` returns a 302 with `Location: /admin/live`.

## Out of scope / follow-ups

- Configuring Cloudflare Access so `/admin/*` actually shows a login screen in production instead of failing closed.
- Any richer landing page (stats overview, etc.) — explicitly rejected in favor of the simpler redirect for now.

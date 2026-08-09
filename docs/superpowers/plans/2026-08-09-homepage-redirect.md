# Homepage Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visiting `/` on the VoIP admin worker redirects to `/admin/live` instead of returning a 404.

**Architecture:** Add a single early route check in `src/worker.ts`'s `fetch` handler that matches `GET /` and returns a 302 redirect to `/admin/live`. No new files, no new auth logic — `/admin/live` already enforces staff auth via `requireStaffUser`.

**Tech Stack:** Cloudflare Workers (TypeScript), Vitest + `@cloudflare/vitest-pool-workers` (`SELF.fetch` test helper), matches spec at `docs/superpowers/specs/2026-08-09-homepage-redirect-design.md`.

## Global Constraints

- Only `GET /` is handled. `/admin` (no trailing path) is explicitly out of scope and must keep 404ing via the existing fallthrough — do not add a route for it.
- The redirect must be a `302`, with a `Location` header of `/admin/live`.
- No new HTML, no new auth code.

---

### Task 1: Add the `/` redirect route and its test

**Files:**
- Modify: `src/worker.ts:27-31` (insert the new route check right after the `url` is parsed, before the existing `/health` check)
- Test: `test/worker.test.ts:1-10` (add a new `describe` block after the existing `"worker health check"` block)

**Interfaces:**
- Consumes: nothing new — uses the `request`/`url` variables already in scope in the `fetch` handler.
- Produces: nothing consumed by later tasks — this is the only task in the plan.

- [ ] **Step 1: Write the failing test**

Open `test/worker.test.ts`. Immediately after the existing `describe("worker health check", ...)` block (which ends at line 10 with `});`), insert:

```ts
describe("GET /", () => {
  it("redirects to /admin/live", async () => {
    const response = await SELF.fetch("https://example.com/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/admin/live");
  });
});
```

Note the `{ redirect: "manual" }` option — without it, the test's `fetch` would silently follow the redirect and you'd end up asserting on the response from `/admin/live` instead of the redirect itself.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- worker.test.ts -t "redirects to /admin/live"`
Expected: FAIL — the response status will be `404` (the current fallthrough "not found" response), not `302`.

- [ ] **Step 3: Write the minimal implementation**

Open `src/worker.ts`. Find this block (currently lines 27-31):

```ts
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
```

Replace it with:

```ts
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.redirect(new URL("/admin/live", url), 302);
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- worker.test.ts -t "redirects to /admin/live"`
Expected: PASS

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: All tests pass, including the pre-existing `"responds 200 ok on GET /health"` test and the `/admin/*` 404 fallthrough behavior implicitly exercised elsewhere in the suite.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts test/worker.test.ts
git commit -m "feat: redirect / to /admin/live"
```

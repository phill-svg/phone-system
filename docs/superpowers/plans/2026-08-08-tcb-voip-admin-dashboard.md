# TCB VoIP — Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin dashboard (business-hours + staff-ring settings, call history, live calls) behind Cloudflare Access, on top of the completed Phase 1 IVR backend — with call-lifecycle tracking and `staff_users`/Access auth as prerequisites, and honest "not available yet" placeholders for sections whose backing data (recording, transcript, listen-in) doesn't exist yet.

**Architecture:** Server-rendered HTML from the existing `tcb-voip` Worker (no Pages project, no frontend framework) — new `/admin/*` HTML routes and `/api/*` JSON routes, both gated by a `requireStaffUser` middleware that verifies a Cloudflare Access JWT (via the `jose` library) and looks up the verified email's role in a new `staff_users` D1 table. `CallSession` gains a completion self-mark so `calls.status`/`ended_at` are real, queryable state, giving the Live Calls page genuine (if currently empty) data instead of a fabricated one.

**Tech Stack:** Same as Phase 1 (Cloudflare Workers, D1, TypeScript, Vitest + `@cloudflare/vitest-pool-workers`), plus the `jose` library (runtime dependency, not dev-only) for Cloudflare Access JWT verification.

## Global Constraints

- **Why `jose`, not hand-rolled JWT verification:** Phase 1's Twilio signature check was a simple, well-documented HMAC-SHA1 construction, safely hand-rolled. Cloudflare Access JWTs are RS256 with JWKS key rotation (`kid`-based key selection) — research turned up no credible hand-rolled `crypto.subtle` reference implementation anywhere, including from Cloudflare itself (their own official examples all use `jose`). This is a deliberate deviation from the Phase 1 hand-rolled-crypto convention, made for this task specifically because the risk profile is different, not a general project-wide change.
- Every HTML-rendered value that ultimately originates from telephony input (caller number, IVR path/tag) MUST go through the shared `escapeHtml()` helper — no exceptions, even where it looks safe today.
- Auth must fail **closed**: the dev-auth bypass activates only on the explicit signal `env.AUTH_MODE === "dev"` (set only in local `.dev.vars`, never in `wrangler.jsonc`'s deployed `vars`); missing real-auth config (`CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`) when not in dev mode is a hard 500, never a silent bypass.
- Business hours remain Australia/Sydney timezone (unchanged from Phase 1, reused as-is via `isWithinBusinessHours`/`getBusinessHours`/`setBusinessHours` — no modification to those functions in this plan).
- HTML pages are tested via markup assertions (elements/values present in the rendered string) through `SELF.fetch()`, not simulated browser JS execution — the inline `<script>` interactivity is verified manually once deployed, consistent with how Phase 1 verified real telephony behavior only via a real test call.
- Package manager: npm. Project root: `C:\Users\Phill\Claude\voip-phone-system`.

---

### Task 1: Call lifecycle — migration + `CallSession` self-mark completion

**Files:**
- Create: `migrations/0002_call_lifecycle.sql`
- Modify: `src/durable-objects/CallSession.ts`
- Test: `test/durable-objects/CallSession.test.ts` (extend)

**Interfaces:**
- Produces: `calls.status` (`'in_progress'` default, `'completed'` on terminal IVR states) and `calls.ended_at` (epoch ms, null until completion) — consumed by `src/db/calls.ts` (Task 7) for the Live Calls query.

- [ ] **Step 1: Create the migration**

Run: `npx wrangler d1 migrations create tcb-voip-db call_lifecycle`
Expected: creates `migrations/0002_call_lifecycle.sql` (empty). Replace its contents with:

```sql
-- migrations/0002_call_lifecycle.sql
ALTER TABLE calls ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress';
ALTER TABLE calls ADD COLUMN ended_at INTEGER;
```

- [ ] **Step 2: Write the failing test (append to `test/durable-objects/CallSession.test.ts`)**

```ts
// test/durable-objects/CallSession.test.ts (add this test)
it("marks the calls row completed when the call reaches a terminal IVR state", async () => {
  const id = env.CALL_SESSION.idFromName("CA-lifecycle");
  const stub = env.CALL_SESSION.get(id);
  await runInDurableObject(stub, (instance) => instance.fetch(event("CA-lifecycle")));
  await runInDurableObject(stub, (instance) => instance.fetch(event("CA-lifecycle", { digits: "1" })));

  const row = await env.DB.prepare("SELECT status, ended_at FROM calls WHERE id = ?")
    .bind("CA-lifecycle")
    .first<{ status: string; ended_at: number | null }>();
  expect(row?.status).toBe("completed");
  expect(row?.ended_at).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- CallSession`
Expected: FAIL — `status` is still `'in_progress'` (default), `ended_at` is `null`.

- [ ] **Step 4: Write the implementation**

In `src/durable-objects/CallSession.ts`, after the existing block that appends terminal-state commands (`if (current.name === "ROUTE_STAFF") { ... } else if (current.name === "VOICEMAIL") { ... }`), add:

```ts
    if (current.name === "ROUTE_STAFF" || current.name === "VOICEMAIL") {
      await this.markCompleted(callSid);
    }
```

And add the new private method (near `applyEvent`):

```ts
  private async markCompleted(callSid: string) {
    // NOTE: correct only while ROUTE_STAFF/VOICEMAIL are terminal (Phase 1/2).
    // Once Phase 3 adds real staff dial/bridge/voicemail-recording, completion
    // detection must move to the dial-completion/bridge-teardown path instead.
    await this.env.DB.prepare(
      "UPDATE calls SET status = 'completed', ended_at = ? WHERE id = ? AND ended_at IS NULL"
    )
      .bind(Date.now(), callSid)
      .run();
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- CallSession`
Expected: PASS. Then run the full suite: `npm test` — expected PASS (no regressions in the other two existing `CallSession` tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_call_lifecycle.sql src/durable-objects/CallSession.ts test/durable-objects/CallSession.test.ts
git commit -m "feat: add call lifecycle tracking (status/ended_at), self-marked on terminal IVR states"
```

---

### Task 2: Twilio call-status callback route

**Files:**
- Create: `src/twilio/statusCallback.ts`
- Modify: `src/worker.ts`
- Test: `test/twilio/statusCallback.test.ts`, `test/worker.test.ts` (extend)

**Interfaces:**
- Produces: `normalizeCallStatus(twilioStatus: string): string | null` (Twilio's `CallStatus` → our normalized status, or `null` for non-terminal statuses) — consumed by the new `POST /webhooks/twilio/status` route in `src/worker.ts`.
- This route catches calls abandoned before reaching a terminal IVR state (Task 1's self-mark never sees them). Wiring Twilio's console to actually call this route is a Task-10-adjacent operational step (needs a real number) — the route's code and tests don't depend on that.

- [ ] **Step 1: Write the failing test for the pure mapper**

```ts
// test/twilio/statusCallback.test.ts
import { describe, expect, it } from "vitest";
import { normalizeCallStatus } from "../../src/twilio/statusCallback";

describe("normalizeCallStatus", () => {
  it.each([
    ["completed", "completed"],
    ["busy", "busy"],
    ["failed", "failed"],
    ["no-answer", "no_answer"],
    ["canceled", "canceled"],
  ] as const)("%s maps to %s", (input, expected) => {
    expect(normalizeCallStatus(input)).toBe(expected);
  });

  it.each(["queued", "ringing", "in-progress"])("%s (non-terminal) maps to null", (input) => {
    expect(normalizeCallStatus(input)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- statusCallback`
Expected: FAIL — `src/twilio/statusCallback.ts` not found.

- [ ] **Step 3: Write the mapper implementation**

```ts
// src/twilio/statusCallback.ts
const TERMINAL_STATUS_MAP: Record<string, string> = {
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled",
};

export function normalizeCallStatus(twilioStatus: string): string | null {
  return TERMINAL_STATUS_MAP[twilioStatus] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- statusCallback`
Expected: PASS

- [ ] **Step 5: Write the failing route test (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add below the existing /webhooks/twilio tests)
describe("POST /webhooks/twilio/status", () => {
  async function sign(url: string, params: Record<string, string>, authToken: string): Promise<string> {
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  it("marks a call completed on a terminal CallStatus", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-status-1", "+61400000000", "+61200000000", Date.now())
      .run();

    const url = "https://example.com/webhooks/twilio/status";
    const params = { CallSid: "CA-status-1", CallStatus: "completed" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT status, ended_at FROM calls WHERE id = ?")
      .bind("CA-status-1")
      .first<{ status: string; ended_at: number | null }>();
    expect(row?.status).toBe("completed");
    expect(row?.ended_at).toBeGreaterThan(0);
  });

  it("does not update on a non-terminal CallStatus", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-status-2", "+61400000001", "+61200000000", Date.now())
      .run();

    const url = "https://example.com/webhooks/twilio/status";
    const params = { CallSid: "CA-status-2", CallStatus: "ringing" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

    const row = await env.DB.prepare("SELECT status, ended_at FROM calls WHERE id = ?")
      .bind("CA-status-2")
      .first<{ status: string; ended_at: number | null }>();
    expect(row?.status).toBe("in_progress");
    expect(row?.ended_at).toBeNull();
  });

  it("rejects an invalid signature", async () => {
    const response = await SELF.fetch("https://example.com/webhooks/twilio/status", {
      method: "POST",
      headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA-x", CallStatus: "completed" }).toString(),
    });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/webhooks/twilio/status` returns 404.

- [ ] **Step 7: Write the route implementation**

In `src/worker.ts`, import the mapper (`import { normalizeCallStatus } from "./twilio/statusCallback";`) and add a new branch alongside the existing `/webhooks/twilio` handling:

```ts
    if (url.pathname === "/webhooks/twilio/status" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const signature = request.headers.get("X-Twilio-Signature") ?? "";
      const valid = await verifyTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      const normalized = normalizeCallStatus(params.CallStatus ?? "");
      if (normalized) {
        await env.DB.prepare("UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL")
          .bind(normalized, Date.now(), params.CallSid)
          .run();
      }

      return new Response("ok", { status: 200 });
    }
```

(Place this branch before the final `return new Response("not found", { status: 404 })`, alongside the existing `/webhooks/twilio` branch — order relative to it doesn't matter since the paths are distinct.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite)

- [ ] **Step 9: Commit**

```bash
git add src/twilio/statusCallback.ts src/worker.ts test/twilio/statusCallback.test.ts test/worker.test.ts
git commit -m "feat: add Twilio call-status callback route for abandoned-call lifecycle tracking"
```

---

### Task 3: `staff_users` table + Phill's admin seed row

**Files:**
- Create: `migrations/0003_staff_users.sql`
- Test: `test/db/migrations.test.ts` (extend)

**Interfaces:**
- Produces: `staff_users(email TEXT PRIMARY KEY, role TEXT CHECK(role IN ('admin','staff')), created_at INTEGER)`, seeded with `phill@tcbpestcontrolcanberra.com.au` as `'admin'` — consumed by `requireStaffUser` (Task 5).

- [ ] **Step 1: Create the migration**

Run: `npx wrangler d1 migrations create tcb-voip-db staff_users`
Expected: creates `migrations/0003_staff_users.sql` (empty). Replace its contents with:

```sql
-- migrations/0003_staff_users.sql
CREATE TABLE staff_users (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at INTEGER NOT NULL
);

INSERT INTO staff_users (email, role, created_at)
VALUES ('phill@tcbpestcontrolcanberra.com.au', 'admin', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
```

- [ ] **Step 2: Write the failing test (append to `test/db/migrations.test.ts`)**

```ts
// test/db/migrations.test.ts (add this test)
it("seeds Phill as the first admin in staff_users", async () => {
  const row = await env.DB.prepare("SELECT role FROM staff_users WHERE email = ?")
    .bind("phill@tcbpestcontrolcanberra.com.au")
    .first<{ role: string }>();
  expect(row?.role).toBe("admin");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- migrations`
Expected: FAIL — no such table `staff_users`.

- [ ] **Step 4: Apply the migration and run test to verify it passes**

Run: `npm test -- migrations`
Expected: PASS (the test harness applies every file in `migrations/` automatically via `readD1Migrations`/`applyD1Migrations` — no extra step needed for the test to pick this up).

- [ ] **Step 5: Apply the migration locally for `wrangler dev` parity**

Run: `npx wrangler d1 migrations apply tcb-voip-db --local`

- [ ] **Step 6: Commit**

```bash
git add migrations/0003_staff_users.sql test/db/migrations.test.ts
git commit -m "feat: add staff_users table, seed Phill as first admin"
```

---

### Task 4: Cloudflare Access JWT verification

**Files:**
- Create: `src/access/verifyAccessJwt.ts`
- Modify: `package.json` (add `jose` as a runtime dependency)
- Test: `test/access/verifyAccessJwt.test.ts`

**Interfaces:**
- Produces: `createAccessVerifier(teamDomain: string, audience: string): (token: string) => Promise<{ email: string } | null>` — consumed by `requireStaffUser` (Task 5). The returned function verifies signature, issuer (`https://{teamDomain}`), audience, and expiry; returns `null` on any failure (never throws to the caller), and lower-cases the verified email.

- [ ] **Step 1: Add `jose` as a dependency**

```json
// package.json — add to "dependencies" (a new top-level key alongside "devDependencies")
"dependencies": {
  "jose": "^5.9.0"
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

```ts
// test/access/verifyAccessJwt.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccessVerifier } from "../../src/access/verifyAccessJwt";

const TEAM_DOMAIN = "tcb-pest.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";
const KID = "test-key-1";

async function setupJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

async function signToken(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: KID }).sign(privateKey);
}

describe("createAccessVerifier", () => {
  const fetchMock = vi.fn();
  let privateKey: CryptoKey;
  let jwks: { keys: Record<string, unknown>[] };

  beforeEach(async () => {
    ({ privateKey, jwks } = await setupJwks());
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(jwks), { headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts a validly signed token and lower-cases the email", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "Phill@TCBPestControlCanberra.com.au",
      aud: [AUDIENCE],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au" });
  });

  it("rejects a token with the wrong audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: ["wrong-aud"],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: [AUDIENCE],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now - 10,
      iat: now - 3600,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: [AUDIENCE],
      iss: `https://${TEAM_DOMAIN}`,
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token.slice(0, -4) + "abcd")).toBeNull();
  });

  it("rejects a token from the wrong issuer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(privateKey, {
      email: "someone@example.com",
      aud: [AUDIENCE],
      iss: "https://someone-elses-team.cloudflareaccess.com",
      exp: now + 3600,
      iat: now,
    });
    const verify = createAccessVerifier(TEAM_DOMAIN, AUDIENCE);
    expect(await verify(token)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- verifyAccessJwt`
Expected: FAIL — `src/access/verifyAccessJwt.ts` not found.

- [ ] **Step 4: Write the implementation**

```ts
// src/access/verifyAccessJwt.ts
import { createRemoteJWKSet, jwtVerify } from "jose";

export type AccessIdentity = {
  email: string;
};

export function createAccessVerifier(
  teamDomain: string,
  audience: string
): (token: string) => Promise<AccessIdentity | null> {
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));

  return async function verifyAccessJwt(token: string): Promise<AccessIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${teamDomain}`,
        audience,
      });
      if (typeof payload.email !== "string") return null;
      return { email: payload.email.toLowerCase() };
    } catch {
      return null;
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- verifyAccessJwt`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/access/verifyAccessJwt.ts test/access/verifyAccessJwt.test.ts
git commit -m "feat: add Cloudflare Access JWT verification via jose"
```

---

### Task 5: `requireStaffUser` auth + role-gate middleware

**Files:**
- Create: `src/access/requireStaffUser.ts`
- Test: `test/access/requireStaffUser.test.ts`

**Interfaces:**
- Consumes: `createAccessVerifier` (Task 4), the `staff_users` table (Task 3).
- Produces: `requireStaffUser(request: Request, env: Env): Promise<StaffUser | Response>` where `StaffUser = { email: string; role: 'admin' | 'staff' }` — consumed by the `/api/*` and `/admin/*` route handlers (Tasks 8, 9, 10, 11, 12). Callers must check `instanceof Response` before treating the result as a `StaffUser`.

Tested as a plain function call (not through `SELF.fetch`), so each test constructs its own `env` object literal directly — no Miniflare binding-override plumbing needed for this task.

- [ ] **Step 1: Write the failing tests**

```ts
// test/access/requireStaffUser.test.ts
import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { requireStaffUser } from "../../src/access/requireStaffUser";

const TEAM_DOMAIN = "tcb-pest.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";
const KID = "test-key-req";

async function setupJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

async function signToken(privateKey: CryptoKey, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, aud: [AUDIENCE], iss: `https://${TEAM_DOMAIN}`, exp: now + 3600, iat: now })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(privateKey);
}

describe("requireStaffUser", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("DELETE FROM staff_users WHERE email != ?")
      .bind("phill@tcbpestcontrolcanberra.com.au")
      .run();
  });

  it("dev mode: returns the configured dev staff user when it exists in staff_users", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev", DEV_STAFF_EMAIL: "phill@tcbpestcontrolcanberra.com.au" };
    const request = new Request("https://example.com/api/me");
    const result = await requireStaffUser(request, env as any);
    expect(result).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" });
  });

  it("dev mode: 500s if DEV_STAFF_EMAIL is not set", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev" };
    const request = new Request("https://example.com/api/me");
    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });

  it("production mode: 401s when the Cf-Access-Jwt-Assertion header is missing", async () => {
    const env = { DB: testEnv.DB, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE };
    const request = new Request("https://example.com/api/me");
    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("production mode: 500s when CF_ACCESS_TEAM_DOMAIN/AUD are not configured", async () => {
    const env = { DB: testEnv.DB };
    const request = new Request("https://example.com/api/me", {
      headers: { "Cf-Access-Jwt-Assertion": "irrelevant" },
    });
    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
  });

  it("production mode: verifies a real token and returns the matching staff_users role", async () => {
    const { privateKey, jwks } = await setupJwks();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(jwks)));
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: testEnv.DB, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE };
    const token = await signToken(privateKey, "phill@tcbpestcontrolcanberra.com.au");
    const request = new Request("https://example.com/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });

    const result = await requireStaffUser(request, env as any);
    expect(result).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" });

    vi.unstubAllGlobals();
  });

  it("production mode: 403s for a verified email not in staff_users", async () => {
    const { privateKey, jwks } = await setupJwks();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(jwks)));
    vi.stubGlobal("fetch", fetchMock);

    const env = { DB: testEnv.DB, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUDIENCE };
    const token = await signToken(privateKey, "unprovisioned@example.com");
    const request = new Request("https://example.com/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });

    const result = await requireStaffUser(request, env as any);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- requireStaffUser`
Expected: FAIL — `src/access/requireStaffUser.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/access/requireStaffUser.ts
import { createAccessVerifier, type AccessIdentity } from "./verifyAccessJwt";

export type StaffUser = { email: string; role: "admin" | "staff" };

type Env = {
  DB: D1Database;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

let cachedVerifier: ((token: string) => Promise<AccessIdentity | null>) | null = null;
let cachedKey = "";

function getVerifier(teamDomain: string, audience: string) {
  const key = `${teamDomain}|${audience}`;
  if (!cachedVerifier || cachedKey !== key) {
    cachedVerifier = createAccessVerifier(teamDomain, audience);
    cachedKey = key;
  }
  return cachedVerifier;
}

export async function requireStaffUser(request: Request, env: Env): Promise<StaffUser | Response> {
  let email: string;

  if (env.AUTH_MODE === "dev") {
    if (!env.DEV_STAFF_EMAIL) {
      return new Response("dev auth misconfigured: DEV_STAFF_EMAIL not set", { status: 500 });
    }
    email = env.DEV_STAFF_EMAIL.toLowerCase();
  } else {
    if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
      return new Response("auth misconfigured", { status: 500 });
    }
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) {
      return new Response("unauthenticated", { status: 401 });
    }
    const verify = getVerifier(env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
    const identity = await verify(token);
    if (!identity) {
      return new Response("unauthenticated", { status: 401 });
    }
    email = identity.email;
  }

  const row = await env.DB.prepare("SELECT email, role FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff" }>();

  if (!row) {
    return new Response("not provisioned", { status: 403 });
  }

  return { email: row.email, role: row.role };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- requireStaffUser`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/access/requireStaffUser.ts test/access/requireStaffUser.test.ts
git commit -m "feat: add requireStaffUser auth+role middleware (dev bypass fails closed)"
```

---

### Task 6: Staff ring list settings

**Files:**
- Modify: `src/db/settings.ts`
- Test: `test/db/settings.test.ts` (extend)

**Interfaces:**
- Produces: `type StaffRingEntry = { label: string; number: string }`, `getStaffRingList(db): Promise<StaffRingEntry[]>` (default `[]`), `setStaffRingList(db, list): Promise<void>` — consumed by the Settings API routes (Task 9) and Settings page (Task 11). Not consumed by any call-routing logic yet (that's a later phase) — this is inert configuration storage only.

- [ ] **Step 1: Write the failing tests (append to `test/db/settings.test.ts`)**

```ts
// test/db/settings.test.ts (add this describe block)
import { getStaffRingList, setStaffRingList } from "../../src/db/settings";

describe("settings.staffRingList", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await getStaffRingList(env.DB)).toEqual([]);
  });

  it("round-trips a ring list", async () => {
    const list = [
      { label: "Phill (mobile)", number: "+61400000000" },
      { label: "On-call", number: "+61400000001" },
    ];
    await setStaffRingList(env.DB, list);
    expect(await getStaffRingList(env.DB)).toEqual(list);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- settings`
Expected: FAIL — `getStaffRingList` is not exported.

- [ ] **Step 3: Write the implementation (append to `src/db/settings.ts`)**

```ts
// src/db/settings.ts (add below the existing business-hours code)
export type StaffRingEntry = { label: string; number: string };

const STAFF_RING_LIST_KEY = "staff_ring_list";

export async function getStaffRingList(db: D1Database): Promise<StaffRingEntry[]> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(STAFF_RING_LIST_KEY)
    .first<{ value: string }>();
  if (!row) return [];
  return JSON.parse(row.value) as StaffRingEntry[];
}

export async function setStaffRingList(db: D1Database, list: StaffRingEntry[]): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(STAFF_RING_LIST_KEY, JSON.stringify(list))
    .run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- settings`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/settings.ts test/db/settings.test.ts
git commit -m "feat: add staff ring list settings storage"
```

---

### Task 7: Shared call query functions

**Files:**
- Create: `src/db/calls.ts`
- Test: `test/db/calls.test.ts`

**Interfaces:**
- Produces: `type CallSummary`, `type CallEventRow`, `listCalls(db, limit?): Promise<CallSummary[]>`, `listLiveCalls(db): Promise<CallSummary[]>`, `getCallDetail(db, callId): Promise<{call, events} | null>` — consumed by both the JSON API (Task 8) and the HTML pages (Tasks 10, 12), so query logic isn't duplicated between them.

- [ ] **Step 1: Write the failing tests**

```ts
// test/db/calls.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getCallDetail, listCalls, listLiveCalls } from "../../src/db/calls";

async function seedCall(id: string, overrides: Partial<{ startedAt: number; status: string }> = {}) {
  await env.DB.prepare(
    "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, "+61400000000", "+61200000000", overrides.startedAt ?? Date.now(), overrides.status ?? "in_progress")
    .run();
}

describe("db/calls", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("listCalls returns calls newest-first, respecting the limit", async () => {
    await seedCall("CA-1", { startedAt: 1000 });
    await seedCall("CA-2", { startedAt: 2000 });
    await seedCall("CA-3", { startedAt: 3000 });

    const result = await listCalls(env.DB, 2);
    expect(result.map((c) => c.id)).toEqual(["CA-3", "CA-2"]);
  });

  it("listLiveCalls returns only in_progress calls", async () => {
    await seedCall("CA-live", { status: "in_progress" });
    await seedCall("CA-done", { status: "completed" });

    const result = await listLiveCalls(env.DB);
    expect(result.map((c) => c.id)).toEqual(["CA-live"]);
  });

  it("getCallDetail returns null for a missing call", async () => {
    expect(await getCallDetail(env.DB, "CA-missing")).toBeNull();
  });

  it("getCallDetail returns the call and its ordered events", async () => {
    await seedCall("CA-detail");
    await env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind("CA-detail", 200, "state_transition", '{"next":{"name":"MAIN_MENU"}}')
      .run();
    await env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind("CA-detail", 100, "state_transition", '{"next":{"name":"GREETING"}}')
      .run();

    const result = await getCallDetail(env.DB, "CA-detail");
    expect(result?.call.id).toBe("CA-detail");
    expect(result?.events.map((e) => e.ts)).toEqual([100, 200]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- db/calls`
Expected: FAIL — `src/db/calls.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/db/calls.ts
export type CallSummary = {
  id: string;
  caller_number: string;
  called_number: string;
  started_at: number;
  ended_at: number | null;
  ivr_path: string | null;
  is_after_hours: number;
  status: string;
};

export type CallEventRow = {
  id: number;
  call_id: string;
  ts: number;
  event_type: string;
  detail: string | null;
};

export async function listCalls(db: D1Database, limit = 50): Promise<CallSummary[]> {
  const result = await db
    .prepare("SELECT * FROM calls ORDER BY started_at DESC LIMIT ?")
    .bind(limit)
    .all<CallSummary>();
  return result.results;
}

export async function listLiveCalls(db: D1Database): Promise<CallSummary[]> {
  const result = await db
    .prepare("SELECT * FROM calls WHERE status = 'in_progress' ORDER BY started_at DESC")
    .all<CallSummary>();
  return result.results;
}

export async function getCallDetail(
  db: D1Database,
  callId: string
): Promise<{ call: CallSummary; events: CallEventRow[] } | null> {
  const call = await db.prepare("SELECT * FROM calls WHERE id = ?").bind(callId).first<CallSummary>();
  if (!call) return null;
  const events = await db
    .prepare("SELECT * FROM call_events WHERE call_id = ? ORDER BY ts ASC")
    .bind(callId)
    .all<CallEventRow>();
  return { call, events: events.results };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- db/calls`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/calls.ts test/db/calls.test.ts
git commit -m "feat: add shared call query functions (listCalls, listLiveCalls, getCallDetail)"
```

---

### Task 8: Calls JSON API routes

**Files:**
- Create: `src/api/respond.ts`, `src/api/me.ts`, `src/api/calls.ts`
- Modify: `src/worker.ts`, `wrangler.jsonc` (add `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` var placeholders), `vitest.config.ts` (add `AUTH_MODE`/`DEV_STAFF_EMAIL` test bindings)
- Test: `test/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `requireStaffUser` (Task 5), `listCalls`/`listLiveCalls`/`getCallDetail` (Task 7).
- Produces: `GET /api/me`, `GET /api/calls`, `GET /api/calls/live`, `GET /api/calls/:id` — all behind the auth guard. Route order matters: `/api/calls/live` must be checked as an exact match before the generic `/api/calls/:id` segment extraction, or `live` would be treated as a call ID.

- [ ] **Step 1: Add test-only auth bindings to `vitest.config.ts`**

```ts
// vitest.config.ts — extend the existing miniflare.bindings object
miniflare: {
  bindings: {
    TEST_MIGRATIONS: migrations,
    TWILIO_AUTH_TOKEN: "test-auth-token",
    AUTH_MODE: "dev",
    DEV_STAFF_EMAIL: "phill@tcbpestcontrolcanberra.com.au",
  },
},
```

- [ ] **Step 2: Add `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` placeholders to `wrangler.jsonc`**

```jsonc
"vars": {
  "CF_ACCESS_TEAM_DOMAIN": "",
  "CF_ACCESS_AUD": ""
}
```

(These are plain identifiers, not secrets — safe as `vars`, unlike `TWILIO_AUTH_TOKEN`. Filled in during the operational Access-setup task.)

- [ ] **Step 3: Write the failing tests (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add this describe block)
describe("GET /api/me and /api/calls*", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("GET /api/me returns the dev-mode staff identity", async () => {
    const response = await SELF.fetch("https://example.com/api/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "phill@tcbpestcontrolcanberra.com.au", role: "admin" });
  });

  it("GET /api/calls returns call summaries newest-first", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-api-1", "+61400000000", "+61200000000", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-api-2", "+61400000001", "+61200000000", 2000)
      .run();

    const response = await SELF.fetch("https://example.com/api/calls");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-api-2", "CA-api-1"]);
  });

  it("GET /api/calls/live returns only in-progress calls", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'completed')"
    )
      .bind("CA-api-done", "+61400000000", "+61200000000", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'in_progress')"
    )
      .bind("CA-api-live", "+61400000001", "+61200000000", 2000)
      .run();

    const response = await SELF.fetch("https://example.com/api/calls/live");
    const body = (await response.json()) as { id: string }[];
    expect(body.map((c) => c.id)).toEqual(["CA-api-live"]);
  });

  it("GET /api/calls/:id returns the call detail with its events", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-api-detail", "+61400000000", "+61200000000", 1000)
      .run();

    const response = await SELF.fetch("https://example.com/api/calls/CA-api-detail");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { call: { id: string }; events: unknown[] };
    expect(body.call.id).toBe("CA-api-detail");
    expect(body.events).toEqual([]);
  });

  it("GET /api/calls/:id returns 404 for a missing call", async () => {
    const response = await SELF.fetch("https://example.com/api/calls/CA-nope");
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/api/*` routes return 404.

- [ ] **Step 5: Write `src/api/respond.ts`**

```ts
// src/api/respond.ts
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 6: Write `src/api/me.ts`**

```ts
// src/api/me.ts
import { jsonResponse } from "./respond";
import type { StaffUser } from "../access/requireStaffUser";

export function handleMe(staff: StaffUser): Response {
  return jsonResponse(staff);
}
```

- [ ] **Step 7: Write `src/api/calls.ts`**

```ts
// src/api/calls.ts
import { jsonResponse } from "./respond";
import { getCallDetail, listCalls, listLiveCalls } from "../db/calls";

export async function handleListCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listCalls(db));
}

export async function handleLiveCalls(db: D1Database): Promise<Response> {
  return jsonResponse(await listLiveCalls(db));
}

export async function handleCallDetail(db: D1Database, callId: string): Promise<Response> {
  const detail = await getCallDetail(db, callId);
  if (!detail) return new Response("not found", { status: 404 });
  return jsonResponse(detail);
}
```

- [ ] **Step 8: Wire the routes into `src/worker.ts`**

Add imports at the top:

```ts
import { requireStaffUser } from "./access/requireStaffUser";
import { handleMe } from "./api/me";
import { handleCallDetail, handleListCalls, handleLiveCalls } from "./api/calls";
```

Extend the `Env` type:

```ts
type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  TWILIO_AUTH_TOKEN: string;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};
```

Add a new branch, before the final `return new Response("not found", { status: 404 })`:

```ts
    if (url.pathname.startsWith("/api/")) {
      const staffOrResponse = await requireStaffUser(request, env);
      if (staffOrResponse instanceof Response) return staffOrResponse;
      const staff = staffOrResponse;

      if (url.pathname === "/api/me") {
        return handleMe(staff);
      }
      if (url.pathname === "/api/calls/live") {
        return handleLiveCalls(env.DB);
      }
      if (url.pathname === "/api/calls") {
        return handleListCalls(env.DB);
      }
      const callIdMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (callIdMatch) {
        return handleCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
      }

      return new Response("not found", { status: 404 });
    }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite)

- [ ] **Step 10: Commit**

```bash
git add src/api/respond.ts src/api/me.ts src/api/calls.ts src/worker.ts wrangler.jsonc vitest.config.ts test/worker.test.ts
git commit -m "feat: add /api/me and /api/calls* JSON routes behind auth guard"
```

---

### Task 9: Settings JSON API routes

**Files:**
- Create: `src/api/settings.ts`
- Modify: `src/worker.ts`
- Test: `test/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `getBusinessHours`/`setBusinessHours`/`getStaffRingList`/`setStaffRingList` (Tasks existing + 6), `StaffUser` (Task 5).
- Produces: `GET/PUT /api/settings/business-hours`, `GET/PUT /api/settings/staff-ring-list`. The `PUT` routes require `staff.role === 'admin'` (the current dev/seed user is admin, so this task's tests exercise the allowed path; a 403-for-non-admin case is included using a second seeded `staff` role row).

- [ ] **Step 1: Write the failing tests (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add this describe block)
describe("GET/PUT /api/settings/*", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("GET /api/settings/business-hours returns the default schedule", async () => {
    const response = await SELF.fetch("https://example.com/api/settings/business-hours");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mon: unknown };
    expect(body.mon).toEqual({ open: "07:00", close: "17:00" });
  });

  it("PUT /api/settings/business-hours saves a new schedule", async () => {
    const schedule = {
      mon: { open: "08:00", close: "16:00" },
      tue: { open: "08:00", close: "16:00" },
      wed: { open: "08:00", close: "16:00" },
      thu: { open: "08:00", close: "16:00" },
      fri: { open: "08:00", close: "16:00" },
      sat: null,
      sun: null,
    };
    const putResponse = await SELF.fetch("https://example.com/api/settings/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(schedule),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await SELF.fetch("https://example.com/api/settings/business-hours");
    expect(await getResponse.json()).toEqual(schedule);
  });

  it("GET /api/settings/staff-ring-list returns an empty list by default", async () => {
    const response = await SELF.fetch("https://example.com/api/settings/staff-ring-list");
    expect(await response.json()).toEqual([]);
  });

  it("PUT /api/settings/staff-ring-list saves entries", async () => {
    const list = [{ label: "Phill", number: "+61400000000" }];
    await SELF.fetch("https://example.com/api/settings/staff-ring-list", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(list),
    });
    const getResponse = await SELF.fetch("https://example.com/api/settings/staff-ring-list");
    expect(await getResponse.json()).toEqual(list);
  });

});
```

**Note on the admin-gating test below:** Phase 1's Task 9 already discovered that mutating `env.X` inside a test does not propagate into the environment `SELF.fetch` actually runs the Worker under — Miniflare bindings are baked in per-isolate, not live-mutable per-test. So the non-admin-403 case is tested as a **direct unit test of the handler function**, not through `SELF.fetch` — the same tactic Task 5 used for `requireStaffUser` to avoid this exact trap.

- [ ] **Step 1b: Write the failing direct-unit test for admin gating**

```ts
// test/api/settings.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePutBusinessHours, handlePutStaffRingList } from "../../src/api/settings";

const STAFF: import("../../src/access/requireStaffUser").StaffUser = { email: "tech@example.com", role: "staff" };

describe("settings admin gating", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("handlePutBusinessHours returns 403 for a non-admin staff user", async () => {
    const request = new Request("https://example.com/api/settings/business-hours", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const response = await handlePutBusinessHours(request, env.DB, STAFF);
    expect(response.status).toBe(403);
  });

  it("handlePutStaffRingList returns 403 for a non-admin staff user", async () => {
    const request = new Request("https://example.com/api/settings/staff-ring-list", {
      method: "PUT",
      body: JSON.stringify([]),
    });
    const response = await handlePutStaffRingList(request, env.DB, STAFF);
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worker` and `npm test -- api/settings`
Expected: both FAIL — `/api/settings/*` returns 404 in `worker.test.ts`, and `src/api/settings.ts` doesn't exist yet so `api/settings.test.ts` fails to even import it.

- [ ] **Step 3: Write `src/api/settings.ts`**

```ts
// src/api/settings.ts
import { jsonResponse } from "./respond";
import { getBusinessHours, getStaffRingList, setBusinessHours, setStaffRingList } from "../db/settings";
import type { BusinessHoursSchedule } from "../ivr/businessHours";
import type { StaffUser } from "../access/requireStaffUser";

function forbiddenUnlessAdmin(staff: StaffUser): Response | null {
  if (staff.role !== "admin") {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

export async function handleGetBusinessHours(db: D1Database): Promise<Response> {
  return jsonResponse(await getBusinessHours(db));
}

export async function handlePutBusinessHours(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  const schedule = (await request.json()) as BusinessHoursSchedule;
  await setBusinessHours(db, schedule);
  return jsonResponse({ ok: true });
}

export async function handleGetStaffRingList(db: D1Database): Promise<Response> {
  return jsonResponse(await getStaffRingList(db));
}

export async function handlePutStaffRingList(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  const list = (await request.json()) as { label: string; number: string }[];
  await setStaffRingList(db, list);
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 4: Wire the routes into `src/worker.ts`**

Add the import and, inside the existing `/api/` branch from Task 8, add before its `return new Response("not found", { status: 404 })`:

```ts
      if (url.pathname === "/api/settings/business-hours") {
        return request.method === "PUT"
          ? handlePutBusinessHours(request, env.DB, staff)
          : handleGetBusinessHours(env.DB);
      }
      if (url.pathname === "/api/settings/staff-ring-list") {
        return request.method === "PUT"
          ? handlePutStaffRingList(request, env.DB, staff)
          : handleGetStaffRingList(env.DB);
      }
```

(Import: `import { handleGetBusinessHours, handleGetStaffRingList, handlePutBusinessHours, handlePutStaffRingList } from "./api/settings";`)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite)

- [ ] **Step 6: Commit**

```bash
git add src/api/settings.ts src/worker.ts test/worker.test.ts test/api/settings.test.ts
git commit -m "feat: add /api/settings/* routes, admin-gated on PUT"
```

---

### Task 10: HTML shell + Call History pages

**Files:**
- Create: `src/html/layout.ts`, `src/html/pages/callHistory.ts`, `src/html/pages/callDetail.ts`
- Modify: `src/worker.ts`
- Test: `test/html/layout.test.ts`, `test/worker.test.ts` (extend)

**Interfaces:**
- Produces: `escapeHtml(value: string): string`, `renderLayout(title, activeNav, bodyHtml): string` — consumed by every page module (this task and Tasks 11, 12). `renderCallHistoryPage(calls: CallSummary[]): string`, `renderCallDetailPage(call, events): string` — consumed by the new `/admin/calls` and `/admin/calls/:id` routes.

- [ ] **Step 1: Write the failing layout test**

```ts
// test/html/layout.test.ts
import { describe, expect, it } from "vitest";
import { escapeHtml, renderLayout } from "../../src/html/layout";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x">Bob & Jane's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Bob &amp; Jane&#39;s&lt;/a&gt;"
    );
  });
});

describe("renderLayout", () => {
  it("includes the escaped title and marks the active nav link", () => {
    const html = renderLayout("Call <History>", "calls", "<p>body</p>");
    expect(html).toContain("Call &lt;History&gt;");
    expect(html).toContain('class="nav-link active"');
    expect(html).toContain("<p>body</p>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- layout`
Expected: FAIL — `src/html/layout.ts` not found.

- [ ] **Step 3: Write `src/html/layout.ts`**

```ts
// src/html/layout.ts
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAV_ITEMS = [
  { href: "/admin/live", label: "Live Calls", key: "live" },
  { href: "/admin/calls", label: "Call History", key: "calls" },
  { href: "/admin/settings", label: "Settings", key: "settings" },
];

export function renderLayout(title: string, activeNav: string, body: string): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.key === activeNav ? " active" : ""}">${escapeHtml(item.label)}</a>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — TCB VoIP Admin</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  header { background: #1a3d2e; color: white; padding: 1rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; }
  header h1 { font-size: 1.1rem; margin: 0; }
  .nav-link { color: #cfe8db; text-decoration: none; }
  .nav-link.active { color: white; font-weight: 600; }
  main { padding: 1.5rem; max-width: 960px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
  .badge-after-hours { background: #fde8e8; color: #9b1c1c; }
  .placeholder { background: #f3f4f6; border: 1px dashed #9ca3af; border-radius: 0.5rem; padding: 1rem; color: #6b7280; margin-top: 1rem; }
  .placeholder button { cursor: not-allowed; opacity: 0.6; }
  form.settings-form label { display: block; margin-bottom: 0.75rem; }
  form.settings-form input { margin-left: 0.5rem; }
  .ring-entry { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
<header><h1>TCB VoIP Admin</h1>${nav}</header>
<main>${body}</main>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- layout`
Expected: PASS

- [ ] **Step 5: Write the failing Call History page tests (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add this describe block)
describe("GET /admin/calls and /admin/calls/:id", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM call_events").run();
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("renders the call history list", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, ivr_path) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("CA-html-1", "+61400000000", "+61200000000", Date.now(), "new_booking")
      .run();

    const response = await SELF.fetch("https://example.com/admin/calls");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("+61400000000");
    expect(html).toContain('href="/admin/calls/CA-html-1"');
  });

  it("renders the call detail page with a disabled recording/transcript placeholder", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at) VALUES (?, ?, ?, ?)"
    )
      .bind("CA-html-2", "+61400000000", "+61200000000", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/calls/CA-html-2");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Not available yet");
    expect(html).toContain("disabled");
  });

  it("404s for a missing call detail page", async () => {
    const response = await SELF.fetch("https://example.com/admin/calls/CA-nope");
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/admin/calls` returns 404.

- [ ] **Step 7: Write `src/html/pages/callHistory.ts`**

```ts
// src/html/pages/callHistory.ts
import { escapeHtml, renderLayout } from "../layout";
import type { CallSummary } from "../../db/calls";

const OUTCOME_LABELS: Record<string, string> = {
  new_booking: "New booking/enquiry",
  existing_job: "Existing job",
  emergency: "Emergency",
  operator: "Operator",
  voicemail: "Voicemail",
};

function formatOutcome(call: CallSummary): string {
  if (call.status === "in_progress") return "In progress";
  if (!call.ivr_path) return "Abandoned";
  return OUTCOME_LABELS[call.ivr_path] ?? call.ivr_path;
}

export function renderCallHistoryPage(calls: CallSummary[]): string {
  const rows = calls
    .map(
      (call) => `<tr>
        <td><a href="/admin/calls/${encodeURIComponent(call.id)}">${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</a></td>
        <td>${escapeHtml(call.caller_number)}</td>
        <td>${escapeHtml(formatOutcome(call))}</td>
        <td>${call.is_after_hours ? '<span class="badge badge-after-hours">After hours</span>' : ""}</td>
      </tr>`
    )
    .join("");
  const body = `<h2>Call History</h2>
    <table>
      <thead><tr><th>Started</th><th>Caller</th><th>Outcome</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No calls yet.</td></tr>'}</tbody>
    </table>`;
  return renderLayout("Call History", "calls", body);
}
```

- [ ] **Step 8: Write `src/html/pages/callDetail.ts`**

```ts
// src/html/pages/callDetail.ts
import { escapeHtml, renderLayout } from "../layout";
import type { CallEventRow, CallSummary } from "../../db/calls";

function formatEvent(event: CallEventRow): string {
  try {
    const detail = event.detail ? JSON.parse(event.detail) : null;
    const nextName = detail?.next?.name ?? "?";
    const tag = detail?.next?.tag;
    return `${event.event_type}: → ${nextName}${tag ? ` (tag: ${tag})` : ""}`;
  } catch {
    return event.event_type;
  }
}

export function renderCallDetailPage(call: CallSummary, events: CallEventRow[]): string {
  const eventRows = events
    .map(
      (event) =>
        `<tr><td>${escapeHtml(new Date(event.ts).toLocaleString("en-AU"))}</td><td>${escapeHtml(formatEvent(event))}</td></tr>`
    )
    .join("");
  const body = `<h2>Call ${escapeHtml(call.id)}</h2>
    <p><strong>Caller:</strong> ${escapeHtml(call.caller_number)} &rarr; ${escapeHtml(call.called_number)}</p>
    <p><strong>Started:</strong> ${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</p>
    <p><strong>Status:</strong> ${escapeHtml(call.status)}</p>
    <h3>Timeline</h3>
    <table><tbody>${eventRows || "<tr><td>No events.</td></tr>"}</tbody></table>
    <div class="placeholder">
      <strong>Recording</strong> — Not available yet, coming in a later phase.
      <div><button disabled>Play recording</button></div>
    </div>
    <div class="placeholder">
      <strong>Transcript</strong> — Not available yet, coming in a later phase.
    </div>`;
  return renderLayout(`Call ${call.id}`, "calls", body);
}
```

- [ ] **Step 9: Wire the routes into `src/worker.ts`**

Add imports:

```ts
import { renderCallHistoryPage } from "./html/pages/callHistory";
import { renderCallDetailPage } from "./html/pages/callDetail";
import { getCallDetail, listCalls } from "./db/calls";
```

Add a new branch, using the same `staffOrResponse` auth pattern as `/api/*` (extract the auth check into a form both branches can use — simplest: duplicate the three-line guard at the top of this branch too, matching the existing project convention of small direct route branches over premature abstraction):

```ts
    if (url.pathname.startsWith("/admin/")) {
      const staffOrResponse = await requireStaffUser(request, env);
      if (staffOrResponse instanceof Response) return staffOrResponse;

      if (url.pathname === "/admin/calls") {
        const html = renderCallHistoryPage(await listCalls(env.DB));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const callIdMatch = url.pathname.match(/^\/admin\/calls\/([^/]+)$/);
      if (callIdMatch) {
        const detail = await getCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
        if (!detail) return new Response("not found", { status: 404 });
        const html = renderCallDetailPage(detail.call, detail.events);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response("not found", { status: 404 });
    }
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite)

- [ ] **Step 11: Commit**

```bash
git add src/html/layout.ts src/html/pages/callHistory.ts src/html/pages/callDetail.ts src/worker.ts test/html/layout.test.ts test/worker.test.ts
git commit -m "feat: add HTML shell and Call History list/detail pages"
```

---

### Task 11: Settings page

**Files:**
- Create: `src/html/pages/settings.ts`
- Modify: `src/worker.ts`
- Test: `test/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `getBusinessHours`, `getStaffRingList` (existing/Task 6), `renderLayout`/`escapeHtml` (Task 10).
- Produces: `renderSettingsPage(schedule, ringList): string` — a business-hours form and a staff-ring-list editor, each with inline JS calling the Task 9 API routes via `fetch`. This task tests the rendered markup only (form fields present with correct values) — the inline `<script>`'s actual `fetch` behavior is verified manually once deployed, per this plan's Global Constraints.

- [ ] **Step 1: Write the failing test (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add this describe block)
describe("GET /admin/settings", () => {
  it("renders the business hours form with current values and the ring list editor", async () => {
    const response = await SELF.fetch("https://example.com/admin/settings");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="business-hours-form"');
    expect(html).toContain('value="07:00"');
    expect(html).toContain('id="ring-list-form"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/admin/settings` returns 404.

- [ ] **Step 3: Write `src/html/pages/settings.ts`**

```ts
// src/html/pages/settings.ts
import { escapeHtml, renderLayout } from "../layout";
import type { BusinessHoursSchedule } from "../../ivr/businessHours";
import type { StaffRingEntry } from "../../db/settings";

const DAYS: (keyof BusinessHoursSchedule)[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export function renderSettingsPage(schedule: BusinessHoursSchedule, ringList: StaffRingEntry[]): string {
  const dayRows = DAYS.map((day) => {
    const window = schedule[day];
    return `<label>
      <input type="checkbox" name="${day}-open" ${window ? "checked" : ""} onchange="document.getElementById('${day}-times').style.display = this.checked ? 'inline' : 'none'">
      ${DAY_LABELS[day]}
      <span id="${day}-times" style="display:${window ? "inline" : "none"}">
        <input type="time" name="${day}-start" value="${escapeHtml(window?.open ?? "07:00")}">
        to
        <input type="time" name="${day}-end" value="${escapeHtml(window?.close ?? "17:00")}">
      </span>
    </label>`;
  }).join("");

  const ringRows = ringList
    .map(
      (entry, i) => `<div class="ring-entry">
        <input type="text" name="ring-label-${i}" value="${escapeHtml(entry.label)}" placeholder="Label">
        <input type="text" name="ring-number-${i}" value="${escapeHtml(entry.number)}" placeholder="+61...">
      </div>`
    )
    .join("");

  const body = `<h2>Settings</h2>
    <form class="settings-form" id="business-hours-form">
      <h3>Business Hours</h3>
      ${dayRows}
      <button type="submit">Save Business Hours</button>
      <span id="hours-save-status"></span>
    </form>
    <form class="settings-form" id="ring-list-form">
      <h3>Staff Ring List <small>(used by staff call-routing — not active yet)</small></h3>
      <div id="ring-entries">${ringRows}</div>
      <button type="button" id="add-ring-entry">Add number</button>
      <button type="submit">Save Ring List</button>
      <span id="ring-save-status"></span>
    </form>
    <script>
      function scheduleFromForm(form) {
        const days = ${JSON.stringify(DAYS)};
        const schedule = {};
        for (const day of days) {
          const checked = form.querySelector('[name="' + day + '-open"]').checked;
          if (!checked) { schedule[day] = null; continue; }
          const start = form.querySelector('[name="' + day + '-start"]').value;
          const end = form.querySelector('[name="' + day + '-end"]').value;
          schedule[day] = { open: start, close: end };
        }
        return schedule;
      }

      document.getElementById('business-hours-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        const status = document.getElementById('hours-save-status');
        const res = await fetch('/api/settings/business-hours', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scheduleFromForm(e.target)),
        });
        status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
      });

      document.getElementById('add-ring-entry').addEventListener('click', function () {
        const container = document.getElementById('ring-entries');
        const i = container.children.length;
        const div = document.createElement('div');
        div.className = 'ring-entry';
        div.innerHTML = '<input type="text" name="ring-label-' + i + '" placeholder="Label">' +
          '<input type="text" name="ring-number-' + i + '" placeholder="+61...">';
        container.appendChild(div);
      });

      document.getElementById('ring-list-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        const status = document.getElementById('ring-save-status');
        const entries = Array.from(document.querySelectorAll('.ring-entry')).map(function (div) {
          const label = div.querySelector('[name^="ring-label-"]').value;
          const number = div.querySelector('[name^="ring-number-"]').value;
          return { label: label, number: number };
        }).filter(function (entry) { return entry.number.trim() !== ''; });
        const res = await fetch('/api/settings/staff-ring-list', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entries),
        });
        status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
      });
    </script>`;
  return renderLayout("Settings", "settings", body);
}
```

- [ ] **Step 4: Wire the route into `src/worker.ts`**

Add imports:

```ts
import { renderSettingsPage } from "./html/pages/settings";
import { getBusinessHours, getStaffRingList } from "./db/settings";
```

Add inside the existing `/admin/` branch (Task 10), before its final `return new Response("not found", { status: 404 })`:

```ts
      if (url.pathname === "/admin/settings") {
        const schedule = await getBusinessHours(env.DB);
        const ringList = await getStaffRingList(env.DB);
        const html = renderSettingsPage(schedule, ringList);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite)

- [ ] **Step 6: Commit**

```bash
git add src/html/pages/settings.ts src/worker.ts test/worker.test.ts
git commit -m "feat: add Settings page (business hours + staff ring list editors)"
```

---

### Task 12: Live Calls page

**Files:**
- Create: `src/html/pages/liveCalls.ts`
- Modify: `src/worker.ts`
- Test: `test/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `listLiveCalls` (Task 7), `renderLayout`/`escapeHtml` (Task 10).
- Produces: `renderLiveCallsPage(calls: CallSummary[]): string` — a real (usually empty) in-progress-calls table, plus a disabled Listen button per row and a visible "not available yet" banner for live transcript/listen-in.

- [ ] **Step 1: Write the failing test (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add this describe block)
describe("GET /admin/live", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calls").run();
  });

  it("renders in-progress calls with a disabled Listen button and an honest placeholder", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, status) VALUES (?, ?, ?, ?, 'in_progress')"
    )
      .bind("CA-live-1", "+61400000000", "+61200000000", Date.now())
      .run();

    const response = await SELF.fetch("https://example.com/admin/live");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("+61400000000");
    expect(html).toContain("disabled");
    expect(html).toContain("Not available yet");
  });

  it("shows an empty-state message when nothing is in progress", async () => {
    const response = await SELF.fetch("https://example.com/admin/live");
    const html = await response.text();
    expect(html).toContain("No calls in progress");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/admin/live` returns 404.

- [ ] **Step 3: Write `src/html/pages/liveCalls.ts`**

```ts
// src/html/pages/liveCalls.ts
import { escapeHtml, renderLayout } from "../layout";
import type { CallSummary } from "../../db/calls";

export function renderLiveCallsPage(calls: CallSummary[]): string {
  const rows = calls
    .map(
      (call) => `<tr>
        <td>${escapeHtml(call.caller_number)}</td>
        <td>${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</td>
        <td><button disabled>Listen</button></td>
      </tr>`
    )
    .join("");
  const body = `<h2>Live Calls</h2>
    <table>
      <thead><tr><th>Caller</th><th>Started</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No calls in progress.</td></tr>'}</tbody>
    </table>
    <div class="placeholder">
      <strong>Live transcript &amp; listen-in</strong> — Not available yet, coming in a later phase.
    </div>`;
  return renderLayout("Live Calls", "live", body);
}
```

- [ ] **Step 4: Wire the route into `src/worker.ts`**

Add imports:

```ts
import { renderLiveCallsPage } from "./html/pages/liveCalls";
import { listLiveCalls } from "./db/calls";
```

Add inside the existing `/admin/` branch, before its final `return new Response("not found", { status: 404 })`:

```ts
      if (url.pathname === "/admin/live") {
        const html = renderLiveCallsPage(await listLiveCalls(env.DB));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (full suite)

- [ ] **Step 6: Commit**

```bash
git add src/html/pages/liveCalls.ts src/worker.ts test/worker.test.ts
git commit -m "feat: add Live Calls page with honest not-available-yet placeholder"
```

---

### Task 13: Cloudflare Access setup + deploy (operational)

This task is operational, not code — it connects the auth system built in Tasks 3–12 to a real Cloudflare Access application. It requires a custom domain/hostname Phill controls (Access cannot protect the default `*.workers.dev` domain — see this plan's design rationale in Task 5).

- [ ] **Step 1: Attach a custom route to the Worker**

In the Cloudflare dashboard (or via `wrangler.jsonc`'s `routes` field), attach a hostname you control (e.g. `voip-admin.tcbpestcontrolcanberra.com.au`, requires that domain/subdomain to be on Cloudflare) to the `tcb-voip` Worker.

- [ ] **Step 2: Create a Cloudflare Access self-hosted application**

Zero Trust dashboard → Access → Applications → Add an application → Self-hosted. Set the application domain to the hostname from Step 1. Add a policy allowing Phill's email (and any other staff emails). Note the **Application Audience (AUD) Tag** shown in the application's settings — this is `CF_ACCESS_AUD`. Note your **team domain** (`https://<team-name>.cloudflareaccess.com`) — the `<team-name>` part is `CF_ACCESS_TEAM_DOMAIN`.

- [ ] **Step 3: Set the real config values and disable the default domain**

```jsonc
// wrangler.jsonc
"vars": {
  "CF_ACCESS_TEAM_DOMAIN": "<team-name>.cloudflareaccess.com",
  "CF_ACCESS_AUD": "<the AUD tag from Step 2>"
},
"workers_dev": false
```

- [ ] **Step 4: Apply migrations to the remote D1 database and deploy**

Run: `npx wrangler d1 migrations apply tcb-voip-db --remote`
Run: `npm run deploy`

- [ ] **Step 5: Verify Access actually gates the dashboard**

Visit `https://<your-custom-hostname>/admin/calls` in a private/incognito browser window. Expected: redirected to a Cloudflare Access login page, not the dashboard directly. After logging in as Phill's email, expected: the dashboard loads and shows real (likely empty) call history.

- [ ] **Step 6: Verify the default `workers.dev` domain no longer serves the dashboard**

Run: `curl https://tcb-voip.<your-subdomain>.workers.dev/admin/calls` (or visit in a browser)
Expected: since `workers_dev: false` was set, this domain should no longer route to the Worker at all (connection/routing failure), confirming the Access bypass risk from Task 5's design is closed.

---

## Self-Review Notes

- **Spec coverage:** Implements the approved dashboard design in full — call lifecycle tracking, `staff_users`/Access auth (with the fail-closed dev bypass and the `workers.dev`-bypass mitigation), staff ring list settings, the shared call-query layer, the full JSON API surface, and all three admin pages (Call History + detail, Settings, Live Calls) with honest placeholders for recording/transcript/listen-in.
- **Type consistency:** `CallSummary`/`CallEventRow` (Task 7) are reused verbatim by the API handlers (Task 8) and HTML pages (Tasks 10, 12) with no renamed fields. `StaffUser`/`AccessIdentity` (Tasks 4–5) flow unchanged into every route handler that needs them (Tasks 8, 9, 10, 11, 12).
- **No placeholders in the code sense:** every step has complete, runnable code. The UI's *visible* "not available yet" placeholders are the deliberate, spec-required feature of this task, not unfinished work — they're tested for (Tasks 10, 12 assert the exact "Not available yet" text and `disabled` attribute are present).
- **Deviation flagged for the human:** Task 4 uses the `jose` library rather than continuing Phase 1's hand-rolled-crypto convention — reasoned about explicitly in Global Constraints, not a silent choice.

# Mobile App Phase 1 — Backend Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Cloudflare Worker API consumable by a mobile client — bearer-token auth, a JSON login/logout, and Twilio Voice tokens that can carry a push credential.

**Architecture:** Extend the auth already built. `requireStaffUser` accepts the session token via `Authorization: Bearer` header as well as the cookie. New public `POST /api/login` (JSON `{token,user}`) and `POST /api/logout` reuse the existing password/session/rate-limit modules. `mintAccessToken` gains an optional `pushCredentialSid` added to the Twilio voice grant. No new UI.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, `jose` (JWT), Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Bearer token = the SAME opaque session token as the cookie (only its SHA-256 is stored in `sessions`); 12h expiry; server-side revocable. Do NOT invent a second token type.
- `Authorization` header format: `Bearer <token>` (case-insensitive scheme). Resolution order in `requireStaffUser`: **cookie first, then bearer**.
- `POST /api/login` and `POST /api/logout` are PUBLIC — registered BEFORE the `/api/` `requireStaffUser` gate (like the existing `/login`). `/api/login` reuses the same rate-limiting (≥8 fails/15min → 429) and anti-enumeration (dummy `verifyPassword` on unknown/no-password email; identical `"Invalid email or password."` message + 401 for unknown-email vs wrong-password).
- `/api/login` returns JSON and does NOT set a cookie. Success shape: `{ "token": string, "user": { "email": string, "role": "admin"|"staff" } }`.
- Twilio voice grant field name is exactly `push_credential_sid` (snake_case), inside the existing `voice` grant object. Omit it entirely when no push credential is supplied — do not emit `push_credential_sid: undefined`.
- `AUTH_MODE=dev` bypass in `requireStaffUser` stays byte-for-byte (the vitest pool sets it; existing `SELF.fetch` tests depend on it). Test the bearer path via `requireStaffUser` unit tests with a non-dev env object (the existing pattern), not via `SELF.fetch`.
- Reuse existing helpers; do not duplicate logic: `verifyPassword`, `getDummyHash` (`src/access/password.ts`); `createSession`, `destroySession`, `lookupSession`, `parseSessionCookie` (`src/access/session.ts`); `isRateLimited`, `recordFailedAttempt`, `clearAttempts` (`src/access/loginAttempts.ts`); `jsonResponse` (`src/api/respond.ts`); `mintAccessToken` (`src/twilio/accessToken.ts`).
- New env vars `TWILIO_PUSH_CREDENTIAL_SID_IOS` / `TWILIO_PUSH_CREDENTIAL_SID_ANDROID` are OPTIONAL (unset until Phase 4). Everything must work with them unset.
- Run tests: `npx vitest run` (full) or a single file `npx vitest run <path>`. The vitest-pool-workers pool can intermittently throw a transient EADDRINUSE / socket error on a full run — if that happens (zero tests executed, infra error, NOT assertion failures), re-run once. A clean full run is ~46 files / 412 tests before this plan.

---

### Task 1: Bearer-token auth in `requireStaffUser`

**Files:**
- Modify: `src/access/session.ts` (add `parseBearerToken`)
- Modify: `src/access/requireStaffUser.ts` (accept cookie OR bearer)
- Test: `test/access/session.test.ts` (parseBearerToken cases), `test/access/requireStaffUser.test.ts` (bearer cases)

**Interfaces:**
- Produces: `parseBearerToken(request: Request): string | null` (from `src/access/session.ts`). `requireStaffUser` unchanged signature `(request, env, { isApi }) => Promise<StaffUser | Response>`, now resolving the session from `parseSessionCookie(request) ?? parseBearerToken(request)`.

- [ ] **Step 1: Write the failing test for `parseBearerToken`**

Add to `test/access/session.test.ts` (inside the existing `describe("sessions", …)`):

```ts
import { parseBearerToken } from "../../src/access/session";

it("parseBearerToken extracts the token from an Authorization header", () => {
  expect(parseBearerToken(new Request("https://x/", { headers: { Authorization: "Bearer abc.def" } }))).toBe("abc.def");
  expect(parseBearerToken(new Request("https://x/", { headers: { Authorization: "bearer XYZ" } }))).toBe("XYZ");
  expect(parseBearerToken(new Request("https://x/"))).toBeNull();
  expect(parseBearerToken(new Request("https://x/", { headers: { Authorization: "Basic abc" } }))).toBeNull();
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run test/access/session.test.ts`
Expected: FAIL — `parseBearerToken` is not exported.

- [ ] **Step 3: Add `parseBearerToken` to `src/access/session.ts`**

Append (near `parseSessionCookie`):

```ts
export function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1].trim() || null) : null;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run test/access/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for bearer auth in `requireStaffUser`**

Add to `test/access/requireStaffUser.test.ts` (inside the existing describe; `createSession` and `sessionCookieHeader` are already imported there — add `parseBearerToken` is NOT needed):

```ts
it("resolves a staff user from an Authorization: Bearer token", async () => {
  const token = await createSession(testEnv.DB, ADMIN);
  const env = { DB: testEnv.DB };
  const req = new Request("https://x/api/me", { headers: { Authorization: `Bearer ${token}` } });
  expect(await requireStaffUser(req, env as any, { isApi: true })).toEqual({ email: ADMIN, role: "admin" });
});

it("401s for an invalid bearer token (api)", async () => {
  const env = { DB: testEnv.DB };
  const req = new Request("https://x/api/me", { headers: { Authorization: "Bearer not-a-real-token" } });
  const res = (await requireStaffUser(req, env as any, { isApi: true })) as Response;
  expect(res.status).toBe(401);
});
```

(`ADMIN` is the constant already defined at the top of that test file.)

- [ ] **Step 6: Run it — expect FAIL**

Run: `npx vitest run test/access/requireStaffUser.test.ts`
Expected: FAIL — bearer token is ignored (no cookie → 401), so the first new test fails.

- [ ] **Step 7: Extend `requireStaffUser`**

In `src/access/requireStaffUser.ts`, change the import and the non-dev branch:

```ts
import { parseSessionCookie, parseBearerToken, lookupSession } from "./session";
```

```ts
  } else {
    const token = parseSessionCookie(request) ?? parseBearerToken(request);
    const sessionEmail = token ? await lookupSession(env.DB, token) : null;
    if (!sessionEmail) return unauthenticated(opts.isApi);
    email = sessionEmail.toLowerCase();
  }
```

- [ ] **Step 8: Run both files + full suite — expect PASS**

Run: `npx vitest run test/access/session.test.ts test/access/requireStaffUser.test.ts && npx vitest run`
Expected: PASS (existing cookie/dev tests still green).

- [ ] **Step 9: Commit**

```bash
git add src/access/session.ts src/access/requireStaffUser.ts test/access/session.test.ts test/access/requireStaffUser.test.ts
git commit -m "feat(mobile): accept session token via Authorization: Bearer header"
```

---

### Task 2: JSON `POST /api/login` and `POST /api/logout`

**Files:**
- Modify: `src/api/auth.ts` (add `handleApiLogin`, `handleApiLogout`)
- Modify: `src/worker.ts` (wire both PUBLIC, before the `/api/` gate; add imports)
- Test: `test/api/mobileAuth.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`, `getDummyHash`; `createSession`, `destroySession`, `parseSessionCookie`, `parseBearerToken`; `isRateLimited`, `recordFailedAttempt`, `clearAttempts`; `jsonResponse`.
- Produces: `handleApiLogin(request, env): Promise<Response>`, `handleApiLogout(request, env): Promise<Response>`. Env type: `{ DB: D1Database }` (the auth.ts local `Env` already includes DB + auth fields — reuse it).

- [ ] **Step 1: Write the failing test**

```ts
// test/api/mobileAuth.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/access/password";

const EMAIL = "mobileuser@example.com";

async function seed(password: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(EMAIL).run();
  await env.DB.prepare("UPDATE staff_users SET password_hash = ? WHERE email = ?").bind(await hashPassword(password), EMAIL).run();
}

describe("mobile JSON auth", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("POST /api/login returns a token + user on correct credentials (no cookie)", async () => {
    await seed("supersecret10");
    const res = await SELF.fetch("https://example.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "supersecret10" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const body = (await res.json()) as { token: string; user: { email: string; role: string } };
    expect(body.token).toBeTruthy();
    expect(body.user).toEqual({ email: EMAIL, role: "staff" });
  });

  it("the returned token authenticates a gated /api call via Bearer header", async () => {
    await seed("supersecret10");
    const login = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "supersecret10" }),
    });
    const { token } = (await login.json()) as { token: string };
    // NOTE: the vitest pool runs AUTH_MODE=dev, so this SELF call is dev-authenticated regardless;
    // this asserts the endpoint accepts the header without error, not the bearer gate itself
    // (that is unit-tested in requireStaffUser.test.ts).
    const me = await SELF.fetch("https://example.com/api/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  it("POST /api/login 401s on wrong password with no token", async () => {
    await seed("supersecret10");
    const res = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "wrongwrong10" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("Invalid email or password.");
  });

  it("POST /api/login 400s on missing fields", async () => {
    const res = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/logout returns ok and revokes the token", async () => {
    await seed("supersecret10");
    const login = await SELF.fetch("https://example.com/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "supersecret10" }),
    });
    const { token } = (await login.json()) as { token: string };
    const out = await SELF.fetch("https://example.com/api/logout", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(200);
    // token row is gone
    const { sha256Hex } = await import("../../src/access/crypto");
    const row = await env.DB.prepare("SELECT token_hash FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).first();
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run test/api/mobileAuth.test.ts`
Expected: FAIL — `/api/login` and `/api/logout` hit the staff gate / 404 (routes not wired).

- [ ] **Step 3: Add handlers to `src/api/auth.ts`**

Add imports (merge with existing import lines — `jsonResponse` and `parseBearerToken` are new):

```ts
import { jsonResponse } from "./respond";
import { parseBearerToken } from "../access/session";
```

Append:

```ts
export async function handleApiLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return jsonResponse({ error: "Enter your email and password." }, 400);

  if (await isRateLimited(env.DB, email)) {
    return jsonResponse({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const user = await env.DB.prepare("SELECT email, role, password_hash FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff"; password_hash: string | null }>();

  if (!user || !user.password_hash) {
    await verifyPassword(password, await getDummyHash());
    await recordFailedAttempt(env.DB, email);
    return jsonResponse({ error: "Invalid email or password." }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await recordFailedAttempt(env.DB, email);
    return jsonResponse({ error: "Invalid email or password." }, 401);
  }

  await clearAttempts(env.DB, email);
  const token = await createSession(env.DB, user.email);
  return jsonResponse({ token, user: { email: user.email, role: user.role } });
}

export async function handleApiLogout(request: Request, env: Env): Promise<Response> {
  const token = parseSessionCookie(request) ?? parseBearerToken(request);
  if (token) await destroySession(env.DB, token);
  return jsonResponse({ ok: true });
}
```

Note: `verifyPassword`, `getDummyHash`, `isRateLimited`, `recordFailedAttempt`, `clearAttempts`, `createSession`, `destroySession`, `parseSessionCookie` are already imported in `auth.ts` from earlier tasks — do NOT re-import them; only add `jsonResponse` and `parseBearerToken`.

- [ ] **Step 4: Wire routes in `src/worker.ts` (PUBLIC — before the `/api/` gate)**

Extend the `./api/auth` import to include the two handlers.

Add this block right after the existing `/login` + `/logout` block (which sits before the `/api/` gate):

```ts
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleApiLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleApiLogout(request, env);
    }
```

These MUST appear before `if (url.pathname.startsWith("/api/")) { … requireStaffUser … }`, or the gate will 401 them.

- [ ] **Step 5: Run it — expect PASS + full suite**

Run: `npx vitest run test/api/mobileAuth.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` (clean).

```bash
git add src/api/auth.ts src/worker.ts test/api/mobileAuth.test.ts
git commit -m "feat(mobile): add JSON POST /api/login and /api/logout"
```

---

### Task 3: Mobile Voice token — optional push-credential grant

**Files:**
- Modify: `src/twilio/accessToken.ts` (optional `pushCredentialSid`)
- Modify: `src/api/softphone.ts` (`handleGetSoftphoneToken` gains a `platform` arg + env push-cred SIDs)
- Modify: `src/worker.ts` (pass `?platform=` to the softphone-token handler; add env fields)
- Test: `test/twilio/accessToken.test.ts` (new), `test/api/softphoneToken.test.ts` (new)

**Interfaces:**
- Produces: `mintAccessToken(opts)` where `opts` gains optional `pushCredentialSid?: string`; when set it appears as `voice.push_credential_sid`. `handleGetSoftphoneToken(env, staff, platform?: string)` — `platform === "ios"` uses `env.TWILIO_PUSH_CREDENTIAL_SID_IOS`, `"android"` uses `env.TWILIO_PUSH_CREDENTIAL_SID_ANDROID`, else none.

- [ ] **Step 1: Write the failing test for the grant**

```ts
// test/twilio/accessToken.test.ts
import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { mintAccessToken } from "../../src/twilio/accessToken";

const base = {
  accountSid: "AC123", apiKeySid: "SK123", apiKeySecret: "secret", twimlAppSid: "AP123", identity: "a@b.com",
};

describe("mintAccessToken", () => {
  it("omits push_credential_sid when not provided", async () => {
    const jwt = await mintAccessToken(base);
    const grants = (decodeJwt(jwt) as any).grants;
    expect(grants.identity).toBe("a@b.com");
    expect(grants.voice.outgoing.application_sid).toBe("AP123");
    expect(grants.voice.incoming.allow).toBe(true);
    expect("push_credential_sid" in grants.voice).toBe(false);
  });

  it("includes push_credential_sid when provided", async () => {
    const jwt = await mintAccessToken({ ...base, pushCredentialSid: "CR999" });
    const grants = (decodeJwt(jwt) as any).grants;
    expect(grants.voice.push_credential_sid).toBe("CR999");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run test/twilio/accessToken.test.ts`
Expected: FAIL — `pushCredentialSid` isn't accepted / grant shape differs.

- [ ] **Step 3: Extend `mintAccessToken`**

Replace the body of `src/twilio/accessToken.ts`'s `mintAccessToken` grant construction:

```ts
export async function mintAccessToken(opts: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
  pushCredentialSid?: string;
}): Promise<string> {
  const key = new TextEncoder().encode(opts.apiKeySecret);
  const voice: Record<string, unknown> = {
    incoming: { allow: true },
    outgoing: { application_sid: opts.twimlAppSid },
  };
  if (opts.pushCredentialSid) voice.push_credential_sid = opts.pushCredentialSid;
  return new SignJWT({ grants: { identity: opts.identity, voice } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1", twr: "au1" })
    .setIssuer(opts.apiKeySid)
    .setSubject(opts.accountSid)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS)
    .sign(key);
}
```

(`TOKEN_TTL_SECONDS` and the `SignJWT` import stay as they are.)

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run test/twilio/accessToken.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the token endpoint**

```ts
// test/api/softphoneToken.test.ts
import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { handleGetSoftphoneToken } from "../../src/api/softphone";

const env = {
  TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "s", TWILIO_TWIML_APP_SID: "AP1",
  TWILIO_PUSH_CREDENTIAL_SID_IOS: "CRios", TWILIO_PUSH_CREDENTIAL_SID_ANDROID: "CRand",
};
const staff = { email: "a@b.com", role: "staff" as const };

describe("handleGetSoftphoneToken platform push credentials", () => {
  async function grantOf(res: Response) {
    const { token } = (await res.json()) as { token: string };
    return (decodeJwt(token) as any).grants.voice;
  }
  it("no platform → no push credential", async () => {
    const voice = await grantOf(await handleGetSoftphoneToken(env as any, staff));
    expect("push_credential_sid" in voice).toBe(false);
  });
  it("platform=ios → iOS push credential", async () => {
    const voice = await grantOf(await handleGetSoftphoneToken(env as any, staff, "ios"));
    expect(voice.push_credential_sid).toBe("CRios");
  });
  it("platform=android → Android push credential", async () => {
    const voice = await grantOf(await handleGetSoftphoneToken(env as any, staff, "android"));
    expect(voice.push_credential_sid).toBe("CRand");
  });
});
```

- [ ] **Step 6: Run it — expect FAIL**

Run: `npx vitest run test/api/softphoneToken.test.ts`
Expected: FAIL — `handleGetSoftphoneToken` ignores `platform`.

- [ ] **Step 7: Extend `handleGetSoftphoneToken` in `src/api/softphone.ts`**

Update the local `Env` type and the function:

```ts
type Env = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_TWIML_APP_SID: string;
  TWILIO_PUSH_CREDENTIAL_SID_IOS?: string;
  TWILIO_PUSH_CREDENTIAL_SID_ANDROID?: string;
};

export async function handleGetSoftphoneToken(env: Env, staff: StaffUser, platform?: string): Promise<Response> {
  const pushCredentialSid =
    platform === "ios" ? env.TWILIO_PUSH_CREDENTIAL_SID_IOS
    : platform === "android" ? env.TWILIO_PUSH_CREDENTIAL_SID_ANDROID
    : undefined;
  const token = await mintAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY_SID,
    apiKeySecret: env.TWILIO_API_KEY_SECRET,
    twimlAppSid: env.TWILIO_TWIML_APP_SID,
    identity: staff.email,
    pushCredentialSid,
  });
  return jsonResponse({ token });
}
```

- [ ] **Step 8: Pass `platform` from `src/worker.ts` + add env fields**

At the softphone-token route (`if (url.pathname === "/api/softphone/token" && request.method === "GET")`), change the call to:

```ts
        return handleGetSoftphoneToken(env, staff, url.searchParams.get("platform") ?? undefined);
```

Add to the worker's `Env` type (near the other optional Twilio vars):

```ts
  TWILIO_PUSH_CREDENTIAL_SID_IOS?: string;
  TWILIO_PUSH_CREDENTIAL_SID_ANDROID?: string;
```

- [ ] **Step 9: Run tests + full suite + typecheck**

Run: `npx vitest run test/twilio/accessToken.test.ts test/api/softphoneToken.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS, tsc clean.

- [ ] **Step 10: Document the optional env vars**

Add a short note to `README.md` (Authentication or a "Mobile" subsection): the app authenticates via `POST /api/login` (bearer token), and `TWILIO_PUSH_CREDENTIAL_SID_IOS` / `TWILIO_PUSH_CREDENTIAL_SID_ANDROID` are optional Worker vars set later (Phase 4) to enable background call push; unset = foreground calling only.

- [ ] **Step 11: Commit**

```bash
git add src/twilio/accessToken.ts src/api/softphone.ts src/worker.ts test/twilio/accessToken.test.ts test/api/softphoneToken.test.ts README.md
git commit -m "feat(mobile): optional push-credential in Voice token; platform-aware softphone token"
```

---

## Self-Review

**Spec coverage:**
- Bearer-token API auth → Task 1. ✅
- JSON `POST /api/login` (token+user, rate-limit, anti-enumeration, no cookie) → Task 2. ✅
- `POST /api/logout` (revoke) → Task 2. ✅
- Mobile Voice token with optional `push_credential_sid` + platform selection → Task 3. ✅
- Optional env vars documented → Task 3 Step 10. ✅
- Public route placement before the `/api/` gate → Task 2 Step 4. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `parseBearerToken(request): string | null` defined in Task 1, consumed in Tasks 1 & 2. `handleApiLogin`/`handleApiLogout(request, env)` consistent between auth.ts and worker.ts wiring. `mintAccessToken` optional `pushCredentialSid?: string` defined in Task 3, consumed by `handleGetSoftphoneToken`. Grant field `push_credential_sid` spelled identically in the impl and all tests.

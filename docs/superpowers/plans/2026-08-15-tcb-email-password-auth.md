# TCB Email + Password Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare Access login with a TCB-branded email + password sign-in served by the Worker, with server-side sessions, and a SendGrid-backed invite/reset flow.

**Architecture:** Custom auth inside the Cloudflare Worker. Passwords hashed with PBKDF2-HMAC-SHA256 (WebCrypto) and stored in D1's `staff_users`. Login creates an opaque session token whose SHA-256 hash is stored in a `sessions` table and set as an `HttpOnly; Secure; SameSite=Lax` cookie. `requireStaffUser` resolves the user from that cookie. Invite/reset use single-use, hashed, expiring tokens emailed via SendGrid. Phase 1 delivers a verifiable login with an email-independent break-glass bootstrap; Phase 2 adds email + staff-admin UI.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), WebCrypto (`crypto.subtle`), Vitest with `@cloudflare/vitest-pool-workers`, SendGrid v3 Mail Send API, Node (`node:crypto`) for the break-glass script only.

## Global Constraints

- Session lifetime: **12 hours**, fixed (no sliding refresh, no "remember me").
- Password rule: **minimum 10 characters**; no complexity requirements.
- Password hash format (exact): `pbkdf2$<iterations>$<saltBase64>$<hashBase64>`, iterations = **210000**, salt = 16 random bytes, derived key = 32 bytes, hash = **SHA-256**. The break-glass Node script MUST produce this identical format (standard base64, not url-safe).
- Token format for sessions and email links: 32 random bytes, **base64url** (url-safe, no padding). Only the **SHA-256 hex** of a token is ever stored server-side; the raw token lives only in the cookie or the emailed URL.
- Token lifetimes: invite = **7 days**, reset = **1 hour**; both single-use.
- Session cookie name: **`tcb_session`**; attributes `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Keep the `AUTH_MODE=dev` + `DEV_STAFF_EMAIL` bypass **unchanged** — the Vitest pool sets these globally (`vitest.config.ts`), and existing `SELF.fetch` tests rely on being auto-authenticated as `phill@tcbpestcontrolcanberra.com.au` (admin).
- Brand tokens (from `src/html/layout.ts`): bg `#0f1013`, surface `#1b1d24`, border `#26282f`, text `#eceef2`, dim `#a7adb8`, mute `#6d7280`, brand red `#e4002b`→`#c10023`, link `#ff5c78`.
- Emails always avoid account enumeration: `POST /forgot-password` returns the same neutral page whether or not the account exists; `POST /login` runs a dummy PBKDF2 verify for unknown emails so timing doesn't leak existence.
- Migrations directory: `migrations/`; next number is **0014** (latest existing is `0013_staff_ring_priority.sql`).
- Run the full suite with `npx vitest run` (or a single file: `npx vitest run test/path.test.ts`).

---

# PHASE 1 — Verifiable branded login (no email dependency)

### Task 1: Migration 0014 — auth schema

**Files:**
- Create: `migrations/0014_auth.sql`
- Test: `test/db/authSchema.test.ts`

**Interfaces:**
- Produces (DB): `staff_users.password_hash TEXT NULL`, `staff_users.password_set_at INTEGER NULL`; tables `sessions(token_hash PK, email, created_at, expires_at)`, `password_tokens(token_hash PK, email, purpose, created_at, expires_at, used_at)`, `login_attempts(id PK, email, attempted_at)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/authSchema.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("0014 auth schema", () => {
  it("adds password columns to staff_users", async () => {
    const info = await env.DB.prepare("PRAGMA table_info(staff_users)").all<{ name: string }>();
    const cols = info.results.map((r) => r.name);
    expect(cols).toContain("password_hash");
    expect(cols).toContain("password_set_at");
  });

  it("creates sessions, password_tokens, login_attempts tables", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','password_tokens','login_attempts')"
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name).sort();
    expect(names).toEqual(["login_attempts", "password_tokens", "sessions"]);
  });

  it("inserts and reads a session row", async () => {
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).bind("hash-1", "phill@tcbpestcontrolcanberra.com.au", 1, 2).run();
    const row = await env.DB.prepare("SELECT email FROM sessions WHERE token_hash = ?").bind("hash-1").first<{ email: string }>();
    expect(row?.email).toBe("phill@tcbpestcontrolcanberra.com.au");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/authSchema.test.ts`
Expected: FAIL — `no such table: sessions` (migration not written yet).

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0014_auth.sql
-- Custom email+password auth: passwords on staff_users, server-side sessions,
-- single-use email tokens (invite/reset), and a login rate-limit ledger.
ALTER TABLE staff_users ADD COLUMN password_hash TEXT;       -- NULL = invited, password not yet set
ALTER TABLE staff_users ADD COLUMN password_set_at INTEGER;  -- ms epoch, NULL until set

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the opaque cookie token
  email      TEXT NOT NULL REFERENCES staff_users(email),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_email ON sessions(email);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE password_tokens (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the one-time link token
  email      TEXT NOT NULL REFERENCES staff_users(email),
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER             -- NULL until consumed; single-use
);
CREATE INDEX idx_password_tokens_email ON password_tokens(email);

CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, attempted_at);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/authSchema.test.ts`
Expected: PASS (the pool auto-applies migrations from `migrations/` before tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/0014_auth.sql test/db/authSchema.test.ts
git commit -m "feat(auth): add 0014 migration for passwords, sessions, tokens, rate-limit"
```

---

### Task 2: Crypto utilities — random token + SHA-256 hex

**Files:**
- Create: `src/access/crypto.ts`
- Test: `test/access/crypto.test.ts`

**Interfaces:**
- Produces: `randomToken(): string` (base64url, 43 chars), `sha256Hex(input: string): Promise<string>` (64 hex chars), `base64Encode(bytes: Uint8Array): string`, `base64Decode(s: string): Uint8Array` (standard base64, used by password hashing).

- [ ] **Step 1: Write the failing test**

```ts
// test/access/crypto.test.ts
import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex, base64Encode, base64Decode } from "../../src/access/crypto";

describe("crypto utils", () => {
  it("randomToken returns url-safe unique tokens", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(42);
  });

  it("sha256Hex is stable and 64 hex chars", async () => {
    const h = await sha256Hex("hello");
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("base64 round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(base64Decode(base64Encode(bytes)))).toEqual([0, 1, 2, 250, 255]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/access/crypto.test.ts`
Expected: FAIL — cannot find module `src/access/crypto`.

- [ ] **Step 3: Write the implementation**

```ts
// src/access/crypto.ts

export function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 32 random bytes as base64url (no padding) — used for session + email-link tokens.
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/access/crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/access/crypto.ts test/access/crypto.test.ts
git commit -m "feat(auth): add crypto utils (randomToken, sha256Hex, base64)"
```

---

### Task 3: Password hashing (PBKDF2)

**Files:**
- Create: `src/access/password.ts`
- Test: `test/access/password.test.ts`

**Interfaces:**
- Consumes: `base64Encode`, `base64Decode` from `src/access/crypto.ts`.
- Produces: `hashPassword(plain: string): Promise<string>` (returns `pbkdf2$210000$<saltB64>$<hashB64>`), `verifyPassword(plain: string, stored: string): Promise<boolean>`, `getDummyHash(): Promise<string>` (a cached valid hash for timing-safe unknown-email handling).

- [ ] **Step 1: Write the failing test**

```ts
// test/access/password.test.ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, getDummyHash } from "../../src/access/password";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^pbkdf2\$210000\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a different salt/hash each time", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects a malformed stored value without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$abc$$")).toBe(false);
  });

  it("getDummyHash returns a valid, verifiable-format hash", async () => {
    const dummy = await getDummyHash();
    expect(dummy).toMatch(/^pbkdf2\$210000\$/);
    expect(await verifyPassword("anything", dummy)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/access/password.test.ts`
Expected: FAIL — cannot find module `src/access/password`.

- [ ] **Step 3: Write the implementation**

```ts
// src/access/password.ts
import { base64Encode, base64Decode } from "./crypto";

const ITERATIONS = 210000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

async function pbkdf2(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(plain), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${base64Encode(salt)}$${base64Encode(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64Decode(parts[2]);
    expected = base64Decode(parts[3]);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await pbkdf2(plain, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// Cached dummy hash so POST /login can burn equivalent time on unknown emails,
// preventing timing-based account enumeration.
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("dummy-password-not-a-real-account");
  return dummyHashPromise;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/access/password.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/access/password.ts test/access/password.test.ts
git commit -m "feat(auth): add PBKDF2 password hashing + timing-safe verify"
```

---

### Task 4: Sessions (D1) + cookie helpers

**Files:**
- Create: `src/access/session.ts`
- Test: `test/access/session.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `sha256Hex` from `src/access/crypto.ts`.
- Produces: `createSession(db, email): Promise<string>` (returns raw token), `lookupSession(db, token): Promise<string | null>` (returns email or null), `destroySession(db, token): Promise<void>`, `destroySessionsForEmail(db, email): Promise<void>`, `parseSessionCookie(request): string | null`, `sessionCookieHeader(token): string`, `clearSessionCookieHeader(): string`, const `SESSION_COOKIE = "tcb_session"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/access/session.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createSession, lookupSession, destroySession, destroySessionsForEmail,
  parseSessionCookie, sessionCookieHeader,
} from "../../src/access/session";

const EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("sessions", () => {
  it("creates a session and looks it up by raw token", async () => {
    const token = await createSession(env.DB, EMAIL);
    expect(await lookupSession(env.DB, token)).toBe(EMAIL);
  });

  it("returns null for an unknown or destroyed token", async () => {
    expect(await lookupSession(env.DB, "nope")).toBeNull();
    const token = await createSession(env.DB, EMAIL);
    await destroySession(env.DB, token);
    expect(await lookupSession(env.DB, token)).toBeNull();
  });

  it("destroySessionsForEmail kills all of a user's sessions", async () => {
    const t1 = await createSession(env.DB, EMAIL);
    const t2 = await createSession(env.DB, EMAIL);
    await destroySessionsForEmail(env.DB, EMAIL);
    expect(await lookupSession(env.DB, t1)).toBeNull();
    expect(await lookupSession(env.DB, t2)).toBeNull();
  });

  it("parseSessionCookie extracts the token; header sets flags", () => {
    const req = new Request("https://x/", { headers: { Cookie: "a=1; tcb_session=abc.def; b=2" } });
    expect(parseSessionCookie(req)).toBe("abc.def");
    const header = sessionCookieHeader("tok");
    expect(header).toContain("tcb_session=tok");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/access/session.test.ts`
Expected: FAIL — cannot find module `src/access/session`.

- [ ] **Step 3: Write the implementation**

```ts
// src/access/session.ts
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "tcb_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function createSession(db: D1Database, email: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, email, now, now + SESSION_TTL_MS)
    .run();
  // Best-effort sweep of expired rows; cheap and keeps the table small.
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return token;
}

export async function lookupSession(db: D1Database, token: string): Promise<string | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT email, expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ email: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return row.email;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function destroySessionsForEmail(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run();
}

export function parseSessionCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE) return trimmed.slice(eq + 1) || null;
  }
  return null;
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/access/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/access/session.ts test/access/session.test.ts
git commit -m "feat(auth): add D1-backed sessions + cookie helpers"
```

---

### Task 5: Login rate limiting (D1)

**Files:**
- Create: `src/access/loginAttempts.ts`
- Test: `test/access/loginAttempts.test.ts`

**Interfaces:**
- Produces: `isRateLimited(db, email): Promise<boolean>`, `recordFailedAttempt(db, email): Promise<void>`, `clearAttempts(db, email): Promise<void>`. Window = 15 min, max = 8 failures.

- [ ] **Step 1: Write the failing test**

```ts
// test/access/loginAttempts.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "../../src/access/loginAttempts";

const EMAIL = "rate@example.com";

describe("login rate limiting", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
  });

  it("is not limited under the threshold and limited at/over it", async () => {
    for (let i = 0; i < 7; i++) await recordFailedAttempt(env.DB, EMAIL);
    expect(await isRateLimited(env.DB, EMAIL)).toBe(false);
    await recordFailedAttempt(env.DB, EMAIL); // 8th
    expect(await isRateLimited(env.DB, EMAIL)).toBe(true);
  });

  it("clearAttempts resets the counter", async () => {
    for (let i = 0; i < 8; i++) await recordFailedAttempt(env.DB, EMAIL);
    await clearAttempts(env.DB, EMAIL);
    expect(await isRateLimited(env.DB, EMAIL)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/access/loginAttempts.test.ts`
Expected: FAIL — cannot find module `src/access/loginAttempts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/access/loginAttempts.ts
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export async function isRateLimited(db: D1Database, email: string): Promise<boolean> {
  const since = Date.now() - WINDOW_MS;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND attempted_at > ?")
    .bind(email, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_ATTEMPTS;
}

export async function recordFailedAttempt(db: D1Database, email: string): Promise<void> {
  await db.prepare("INSERT INTO login_attempts (email, attempted_at) VALUES (?, ?)").bind(email, Date.now()).run();
}

export async function clearAttempts(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/access/loginAttempts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/access/loginAttempts.ts test/access/loginAttempts.test.ts
git commit -m "feat(auth): add D1 login rate limiting (8 fails / 15 min)"
```

---

### Task 6: Rewrite `requireStaffUser` to session-based; remove CF Access verifier

**Files:**
- Modify (rewrite): `src/access/requireStaffUser.ts`
- Delete: `src/access/verifyAccessJwt.ts`
- Modify (rewrite): `test/access/requireStaffUser.test.ts`

**Interfaces:**
- Consumes: `parseSessionCookie`, `lookupSession` from `src/access/session.ts`.
- Produces: `requireStaffUser(request, env, opts: { isApi: boolean }): Promise<StaffUser | Response>`. Type `StaffUser = { email: string; role: "admin" | "staff" }`. Env needs only `{ DB; AUTH_MODE?; DEV_STAFF_EMAIL? }`. Behavior: dev mode → `DEV_STAFF_EMAIL`; else read session cookie. No/invalid session → **302 to `/login`** when `!isApi`, **401** when `isApi`. Authenticated identity not in `staff_users` → **403 "not provisioned"**. Dev mode with no `DEV_STAFF_EMAIL` → **500**.

- [ ] **Step 1: Find the current CF-Access verifier reference**

Run: `git grep -n "verifyAccessJwt\|Cf-Access-Jwt-Assertion\|CF_ACCESS"`
Expected: hits in `src/access/requireStaffUser.ts`, `src/access/verifyAccessJwt.ts`, `src/worker.ts`, and the test. (Worker `Env` cleanup is Task 10; the two call-sites in worker are updated in Step 5 below because the signature changes.)

- [ ] **Step 2: Rewrite the test to describe session-based auth**

```ts
// test/access/requireStaffUser.test.ts
import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { requireStaffUser } from "../../src/access/requireStaffUser";
import { createSession } from "../../src/access/session";
import { sessionCookieHeader } from "../../src/access/session";

const ADMIN = "phill@tcbpestcontrolcanberra.com.au";

describe("requireStaffUser (session-based)", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("DELETE FROM staff_users WHERE email != ?").bind(ADMIN).run();
    await testEnv.DB.prepare("DELETE FROM sessions").run();
  });

  it("dev mode returns the configured dev staff user", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev", DEV_STAFF_EMAIL: ADMIN };
    const req = new Request("https://x/api/me");
    expect(await requireStaffUser(req, env as any, { isApi: true })).toEqual({ email: ADMIN, role: "admin" });
  });

  it("dev mode 500s if DEV_STAFF_EMAIL is unset", async () => {
    const env = { DB: testEnv.DB, AUTH_MODE: "dev" };
    const res = (await requireStaffUser(new Request("https://x/api/me"), env as any, { isApi: true })) as Response;
    expect(res.status).toBe(500);
  });

  it("no session: API request → 401", async () => {
    const env = { DB: testEnv.DB };
    const res = (await requireStaffUser(new Request("https://x/api/me"), env as any, { isApi: true })) as Response;
    expect(res.status).toBe(401);
  });

  it("no session: page request → 302 to /login", async () => {
    const env = { DB: testEnv.DB };
    const res = (await requireStaffUser(new Request("https://x/admin/live"), env as any, { isApi: false })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("valid session cookie → resolves staff user with role", async () => {
    const token = await createSession(testEnv.DB, ADMIN);
    const env = { DB: testEnv.DB };
    const req = new Request("https://x/admin/live", { headers: { Cookie: sessionCookieHeader(token) } });
    expect(await requireStaffUser(req, env as any, { isApi: false })).toEqual({ email: ADMIN, role: "admin" });
  });

  it("valid session but user removed from staff_users → 403", async () => {
    await testEnv.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind("ghost@example.com").run();
    const token = await createSession(testEnv.DB, "ghost@example.com");
    await testEnv.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind("ghost@example.com").run();
    const env = { DB: testEnv.DB };
    const req = new Request("https://x/api/me", { headers: { Cookie: sessionCookieHeader(token) } });
    const res = (await requireStaffUser(req, env as any, { isApi: true })) as Response;
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/access/requireStaffUser.test.ts`
Expected: FAIL — `requireStaffUser` still expects the old signature / reads the CF header (302/401 assertions fail).

- [ ] **Step 4: Rewrite `requireStaffUser` and delete the CF verifier**

```ts
// src/access/requireStaffUser.ts
import { parseSessionCookie, lookupSession } from "./session";

export type StaffUser = { email: string; role: "admin" | "staff" };

type Env = {
  DB: D1Database;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
};

function unauthenticated(isApi: boolean): Response {
  return isApi
    ? new Response("unauthenticated", { status: 401 })
    : new Response(null, { status: 302, headers: { Location: "/login" } });
}

export async function requireStaffUser(
  request: Request,
  env: Env,
  opts: { isApi: boolean }
): Promise<StaffUser | Response> {
  let email: string;

  if (env.AUTH_MODE === "dev") {
    if (!env.DEV_STAFF_EMAIL) {
      return new Response("dev auth misconfigured: DEV_STAFF_EMAIL not set", { status: 500 });
    }
    email = env.DEV_STAFF_EMAIL.toLowerCase();
  } else {
    const token = parseSessionCookie(request);
    const sessionEmail = token ? await lookupSession(env.DB, token) : null;
    if (!sessionEmail) return unauthenticated(opts.isApi);
    email = sessionEmail.toLowerCase();
  }

  const row = await env.DB.prepare("SELECT email, role FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff" }>();

  if (!row) return new Response("not provisioned", { status: 403 });

  return { email: row.email, role: row.role };
}
```

```bash
git rm src/access/verifyAccessJwt.ts
```

- [ ] **Step 5: Update the two call-sites in `src/worker.ts` to pass `opts`**

In the `/api/` block (`src/worker.ts:509`):

```ts
      const staffOrResponse = await requireStaffUser(request, env, { isApi: true });
```

In the `/admin/` block (`src/worker.ts:645`):

```ts
      const staffOrResponse = await requireStaffUser(request, env, { isApi: false });
```

- [ ] **Step 6: Run the auth test + full suite to verify green**

Run: `npx vitest run test/access/requireStaffUser.test.ts && npx vitest run`
Expected: PASS. Existing `SELF.fetch` `/admin` and `/api` tests still pass because the pool sets `AUTH_MODE=dev`.

- [ ] **Step 7: Commit**

```bash
git add src/access/requireStaffUser.ts src/worker.ts test/access/requireStaffUser.test.ts
git rm --cached src/access/verifyAccessJwt.ts 2>/dev/null; git add -A src/access
git commit -m "feat(auth): session-based requireStaffUser; drop Cloudflare Access verifier"
```

---

### Task 7: Auth page renderers (login / forgot / set-password / message)

**Files:**
- Create: `src/html/pages/login.ts`
- Test: `test/html/login.test.ts`

**Interfaces:**
- Produces: `renderLoginPage(opts?: { error?: string; email?: string }): string`, `renderForgotPasswordPage(opts?: { error?: string; done?: boolean }): string`, `renderSetPasswordPage(opts: { token: string; email: string; error?: string }): string`, `renderAuthMessagePage(opts: { title: string; message: string }): string`. All standalone HTML documents (NOT the admin nav shell). Reuse `escapeHtml` from `src/html/layout.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/html/login.test.ts
import { describe, expect, it } from "vitest";
import { renderLoginPage, renderForgotPasswordPage, renderSetPasswordPage } from "../../src/html/pages/login";

describe("auth pages", () => {
  it("login page has email+password fields posting to /login and TCB branding", () => {
    const html = renderLoginPage();
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain("TCB VoIP");
    expect(html).toContain("#e4002b");
    expect(html).not.toContain("nav-link"); // not the admin shell
  });

  it("login page shows and escapes an error", () => {
    expect(renderLoginPage({ error: "Invalid <x> & y" })).toContain("Invalid &lt;x&gt; &amp; y");
  });

  it("set-password page embeds the token in a hidden field and shows the email", () => {
    const html = renderSetPasswordPage({ token: "tok-123", email: "jake@example.com" });
    expect(html).toContain('name="token"');
    expect(html).toContain('value="tok-123"');
    expect(html).toContain("jake@example.com");
    expect(html).toContain('action="/set-password"');
  });

  it("forgot page posts to /forgot-password; done state shows neutral message", () => {
    expect(renderForgotPasswordPage()).toContain('action="/forgot-password"');
    expect(renderForgotPasswordPage({ done: true })).toContain("we've sent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html/login.test.ts`
Expected: FAIL — cannot find module `src/html/pages/login`.

- [ ] **Step 3: Write the implementation**

```ts
// src/html/pages/login.ts
import { escapeHtml } from "../layout";

function shell(title: string, cardBody: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — TCB VoIP</title>
<style>
  :root { --bg:#0f1013; --surface:#1b1d24; --border:#26282f; --text:#eceef2; --dim:#a7adb8; --mute:#6d7280; --brand:#e4002b; --link:#ff5c78; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
         display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
  .card { width: 100%; max-width: 340px; background: var(--surface); border: 1px solid var(--border);
          border-radius: 14px; padding: 1.75rem 1.6rem; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  .brand { display: flex; align-items: center; gap: 0.55rem; margin-bottom: 1.35rem; }
  .brand .mark { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(180deg,#e4002b,#c10023);
                 display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 800; font-size: 0.8rem; }
  .brand .word { font-weight: 700; font-size: 0.95rem; }
  h1 { font-size: 1.05rem; margin: 0 0 0.15rem; }
  .subtitle { color: var(--dim); font-size: 0.8rem; margin: 0 0 1.15rem; }
  label { display: block; color: var(--dim); font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 0.35rem; }
  input { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
          padding: 0.6rem 0.7rem; font-size: 0.9rem; margin-bottom: 0.9rem; }
  input:focus { outline: none; border-color: var(--brand); }
  button { width: 100%; background: linear-gradient(180deg,#e4002b,#c10023); color: #fff; border: none; border-radius: 9px;
           padding: 0.65rem; font-weight: 600; font-size: 0.9rem; cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .error { background: rgba(228,0,43,0.14); border: 1px solid rgba(228,0,43,0.4); color: #ff9aab;
           border-radius: 8px; padding: 0.55rem 0.7rem; font-size: 0.8rem; margin-bottom: 0.95rem; }
  .links { text-align: center; margin-top: 0.95rem; font-size: 0.8rem; }
  .links a { color: var(--link); text-decoration: none; }
  .hint { color: var(--mute); font-size: 0.72rem; margin: -0.5rem 0 0.9rem; }
</style>
</head>
<body>
<div class="card">
  <div class="brand"><div class="mark">TCB</div><div class="word">TCB VoIP</div></div>
  ${cardBody}
</div>
</body>
</html>`;
}

export function renderLoginPage(opts?: { error?: string; email?: string }): string {
  const err = opts?.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
  const email = opts?.email ? escapeHtml(opts.email) : "";
  return shell(
    "Sign in",
    `<h1>Sign in</h1>
     <p class="subtitle">Staff access only</p>
     ${err}
     <form method="post" action="/login">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="username" required value="${email}">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required>
       <button type="submit">Sign in</button>
     </form>
     <div class="links"><a href="/forgot-password">Forgot password?</a></div>`
  );
}

export function renderForgotPasswordPage(opts?: { error?: string; done?: boolean }): string {
  if (opts?.done) {
    return shell(
      "Reset password",
      `<h1>Check your email</h1>
       <p class="subtitle">If that address is registered, we've sent a link to reset your password.</p>
       <div class="links"><a href="/login">← Back to sign in</a></div>`
    );
  }
  const err = opts?.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
  return shell(
    "Reset password",
    `<h1>Reset your password</h1>
     <p class="subtitle">Enter your email and we'll send you a link to set a new password.</p>
     ${err}
     <form method="post" action="/forgot-password">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="username" required>
       <button type="submit">Send reset link</button>
     </form>
     <div class="links"><a href="/login">← Back to sign in</a></div>`
  );
}

export function renderSetPasswordPage(opts: { token: string; email: string; error?: string }): string {
  const err = opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
  return shell(
    "Choose a password",
    `<h1>Choose a password</h1>
     <p class="subtitle">for ${escapeHtml(opts.email)}</p>
     ${err}
     <form method="post" action="/set-password">
       <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
       <label for="password">New password</label>
       <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
       <label for="confirm">Confirm password</label>
       <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
       <p class="hint">At least 10 characters.</p>
       <button type="submit">Save &amp; sign in</button>
     </form>`
  );
}

export function renderAuthMessagePage(opts: { title: string; message: string }): string {
  return shell(
    opts.title,
    `<h1>${escapeHtml(opts.title)}</h1>
     <p class="subtitle">${escapeHtml(opts.message)}</p>
     <div class="links"><a href="/login">← Back to sign in</a></div>`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/html/login.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/html/pages/login.ts test/html/login.test.ts
git commit -m "feat(auth): add branded login/forgot/set-password page renderers"
```

---

### Task 8: Wire `/login` + `/logout` routes into the Worker

**Files:**
- Create: `src/api/auth.ts`
- Modify: `src/worker.ts` (add imports + public routes before the `/admin` and `/api` blocks)
- Test: `test/api/auth.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`, `getDummyHash` (password.ts); `createSession`, `destroySession`, `sessionCookieHeader`, `clearSessionCookieHeader`, `parseSessionCookie` (session.ts); `isRateLimited`, `recordFailedAttempt`, `clearAttempts` (loginAttempts.ts); `renderLoginPage` (login.ts).
- Produces: `handleLoginPage(request, env): Promise<Response>`, `handleLoginSubmit(request, env): Promise<Response>`, `handleLogout(request, env): Promise<Response>`. Env type: `{ DB: D1Database; AUTH_MODE?: string; DEV_STAFF_EMAIL?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/auth.test.ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/access/password";

const EMAIL = "loginer@example.com";

async function seedUser(password: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(EMAIL).run();
  await env.DB.prepare("UPDATE staff_users SET password_hash = ? WHERE email = ?").bind(await hashPassword(password), EMAIL).run();
}

describe("login routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("GET /login returns the branded form", async () => {
    const res = await SELF.fetch("https://example.com/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain('name="password"');
  });

  it("POST /login with correct creds sets a session cookie and redirects", async () => {
    await seedUser("supersecret10");
    const res = await SELF.fetch("https://example.com/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: EMAIL, password: "supersecret10" }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/live");
    expect(res.headers.get("Set-Cookie") ?? "").toContain("tcb_session=");
  });

  it("POST /login with wrong password re-renders with an error and no cookie", async () => {
    await seedUser("supersecret10");
    const res = await SELF.fetch("https://example.com/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: EMAIL, password: "wrongwrong10" }).toString(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("Invalid email or password");
  });

  it("GET /logout clears the cookie and redirects to /login", async () => {
    const res = await SELF.fetch("https://example.com/logout", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Set-Cookie") ?? "").toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/auth.test.ts`
Expected: FAIL — `/login` currently falls through to 404 (route not wired).

- [ ] **Step 3: Write `src/api/auth.ts`**

```ts
// src/api/auth.ts
import { verifyPassword, getDummyHash } from "../access/password";
import { createSession, destroySession, parseSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from "../access/session";
import { isRateLimited, recordFailedAttempt, clearAttempts } from "../access/loginAttempts";
import { renderLoginPage } from "../html/pages/login";

type Env = { DB: D1Database; AUTH_MODE?: string; DEV_STAFF_EMAIL?: string };

function html(body: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...(extraHeaders ?? {}) } });
}

export async function handleLoginPage(_request: Request, _env: Env): Promise<Response> {
  return html(renderLoginPage());
}

export async function handleLoginSubmit(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");

  if (!email || !password) {
    return html(renderLoginPage({ error: "Enter your email and password.", email }), 400);
  }

  if (await isRateLimited(env.DB, email)) {
    return html(renderLoginPage({ error: "Too many attempts. Try again in a few minutes.", email }), 429);
  }

  const user = await env.DB.prepare("SELECT email, password_hash FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; password_hash: string | null }>();

  // Unknown email or password not set yet: burn equivalent time, then fail generically.
  if (!user || !user.password_hash) {
    await verifyPassword(password, await getDummyHash());
    await recordFailedAttempt(env.DB, email);
    return html(renderLoginPage({ error: "Invalid email or password.", email }), 401);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    await recordFailedAttempt(env.DB, email);
    return html(renderLoginPage({ error: "Invalid email or password.", email }), 401);
  }

  await clearAttempts(env.DB, email);
  const token = await createSession(env.DB, user.email);
  return new Response(null, {
    status: 302,
    headers: { Location: "/admin/live", "Set-Cookie": sessionCookieHeader(token) },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = parseSessionCookie(request);
  if (token) await destroySession(env.DB, token);
  return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": clearSessionCookieHeader() } });
}
```

- [ ] **Step 4: Wire routes in `src/worker.ts`**

Add imports near the other `./api/*` imports (after the `handleMe` import, `src/worker.ts:7`):

```ts
import { handleLoginPage, handleLoginSubmit, handleLogout } from "./api/auth";
```

Add these routes immediately after the `/health` block (`src/worker.ts:87`, before the Twilio webhook routes):

```ts
    if (url.pathname === "/login") {
      if (request.method === "GET") return handleLoginPage(request, env);
      if (request.method === "POST") return handleLoginSubmit(request, env);
    }

    if (url.pathname === "/logout") {
      return handleLogout(request, env);
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/api/auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/auth.ts src/worker.ts test/api/auth.test.ts
git commit -m "feat(auth): wire /login and /logout routes"
```

---

### Task 9: Break-glass admin bootstrap script

**Files:**
- Create: `scripts/set-password.mjs`
- Test: `test/access/breakglass-format.test.ts`

**Interfaces:**
- Produces: a Node script printing an `UPDATE staff_users …` SQL statement whose `password_hash` verifies against `verifyPassword` from Task 3. This proves format compatibility between Node `pbkdf2Sync` and WebCrypto `deriveBits`.

- [ ] **Step 1: Write the failing test**

```ts
// test/access/breakglass-format.test.ts
// Verifies a hash produced by node:crypto (same algo/format as scripts/set-password.mjs)
// is accepted by the Worker's verifyPassword — guarding against a format drift that
// would make the break-glass path silently useless.
import { describe, expect, it } from "vitest";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { verifyPassword } from "../../src/access/password";

function nodeHash(password: string): string {
  const ITER = 210000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITER, 32, "sha256");
  return `pbkdf2$${ITER}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

describe("break-glass hash format", () => {
  it("node-generated hash verifies in the Worker", async () => {
    const stored = nodeHash("break-glass-pass-123");
    expect(await verifyPassword("break-glass-pass-123", stored)).toBe(true);
    expect(await verifyPassword("nope", stored)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/access/breakglass-format.test.ts`
Expected: PASS already (this test doesn't import the script; it locks the format contract). If it FAILS, the Task 3 hash format is wrong — fix Task 3 before continuing.

- [ ] **Step 3: Write the script**

```js
// scripts/set-password.mjs
// Break-glass: set a staff member's password WITHOUT email/SendGrid.
// Usage:
//   node scripts/set-password.mjs <email> <password>
// Then run the printed SQL against D1, e.g.:
//   node scripts/set-password.mjs phill@tcbpestcontrolcanberra.com.au 'SomeStrongPass' \
//     | npx wrangler d1 execute tcb-voip-db --remote --command "$(cat)"
// (or copy the line and pass it to --command directly).
import { pbkdf2Sync, randomBytes } from "node:crypto";

const [, , emailArg, password] = process.argv;
if (!emailArg || !password) {
  console.error("usage: node scripts/set-password.mjs <email> <password>");
  process.exit(1);
}
if (password.length < 10) {
  console.error("password must be at least 10 characters");
  process.exit(1);
}

const ITER = 210000;
const email = emailArg.toLowerCase();
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITER, 32, "sha256");
const stored = `pbkdf2$${ITER}$${salt.toString("base64")}$${hash.toString("base64")}`;

// Single-quote-safe: base64 never contains a single quote.
console.log(
  `UPDATE staff_users SET password_hash = '${stored}', password_set_at = ${Date.now()} WHERE email = '${email}';`
);
```

- [ ] **Step 4: Smoke-test the script locally**

Run: `node scripts/set-password.mjs test@example.com 'strongpass10'`
Expected: prints one `UPDATE staff_users SET password_hash = 'pbkdf2$210000$…' …` line.

- [ ] **Step 5: Commit**

```bash
git add scripts/set-password.mjs test/access/breakglass-format.test.ts
git commit -m "feat(auth): add break-glass set-password script + format-compat test"
```

---

### Task 10: Config cleanup — drop CF Access vars, keep dev bypass

**Files:**
- Modify: `wrangler.jsonc` (remove `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`)
- Modify: `src/worker.ts` (remove `CF_ACCESS_*` from the `Env` type)
- Modify: `cloudflare.d.ts` (remove CF Access fields if present)

**Interfaces:**
- Produces: an `Env` with no CF Access fields. No behavioral change (Task 6 already stopped reading them).

- [ ] **Step 1: Find remaining references**

Run: `git grep -n "CF_ACCESS"`
Expected: hits in `wrangler.jsonc`, `src/worker.ts` (Env type), possibly `cloudflare.d.ts`.

- [ ] **Step 2: Remove from `wrangler.jsonc`**

Change the `vars` block to drop the two CF Access lines:

```jsonc
  "vars": {
    "TWILIO_FROM_NUMBER": "+61866108941",
    "TWILIO_TWIML_APP_SID": "AP37a6e4263508806aa37efaf19285d2ed"
  }
```

- [ ] **Step 3: Remove from the `Env` type in `src/worker.ts`**

Delete these two lines from the `Env` type (`src/worker.ts:61-62`):

```ts
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
```

- [ ] **Step 4: Remove any CF Access field from `cloudflare.d.ts`**

If `git grep CF_ACCESS cloudflare.d.ts` shows fields, delete those lines. If none, skip.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, no references to `CF_ACCESS` remain (`git grep CF_ACCESS` → empty).

- [ ] **Step 6: Commit**

```bash
git add wrangler.jsonc src/worker.ts cloudflare.d.ts
git commit -m "chore(auth): remove Cloudflare Access config vars"
```

---

### Task 11: Phase 1 cutover checklist (manual / ops — no code)

**Files:**
- Create: `docs/superpowers/runbooks/auth-cutover.md`

**Interfaces:** none (operational runbook).

This task has no automated test — its deliverable is a runbook Phill follows to switch production safely. It MUST be executed in order, and CF Access is only disabled after login is proven.

- [ ] **Step 1: Write the runbook**

```markdown
# Auth cutover runbook (Phase 1)

Precondition: Phases 1 tasks 1–10 are merged and deployed.

1. Deploy the Worker (`npx wrangler deploy`) with Cloudflare Access STILL ENABLED.
2. Seed the admin password with the break-glass script (no email needed):
   `node scripts/set-password.mjs phill@tcbpestcontrolcanberra.com.au '<strong-pass>'`
   then run the printed SQL:
   `npx wrangler d1 execute tcb-voip-db --remote --command "<the UPDATE statement>"`
3. Verify login WHILE Access is still up — pick one:
   - Preview: deploy to a preview URL not behind Access and sign in there; OR
   - Add `/login`, `/logout`, `/forgot-password`, `/set-password` to the Access
     application's Bypass policy, then visit `/login` and sign in.
   Confirm: correct password → redirected to `/admin/live` and pages load;
   wrong password → "Invalid email or password"; `/admin/live` in a fresh
   private window with no cookie → redirected to `/login`.
4. ONLY after step 3 passes: disable the Cloudflare Access application for the
   hostname in the Zero Trust dashboard.
5. Re-verify: in a fresh private window, `/admin/live` → `/login` (our page, not
   Cloudflare's) → sign in → dashboard. `/webhooks/twilio` still reachable
   (place a test call or confirm Twilio console shows 200s).
6. Rollback if broken: re-enable the Access application; existing sessions and
   the break-glass password remain valid for the next attempt.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/auth-cutover.md
git commit -m "docs(auth): add Phase 1 cutover runbook"
```

**⏸ CHECKPOINT:** Phase 1 is complete and independently shippable. A branded email+password login works and Access can be safely retired. Proceed to Phase 2 for self-service invite/reset.

---

# PHASE 2 — Email invite/reset + staff-admin UI

### Task 12: Password tokens (D1)

**Files:**
- Create: `src/access/passwordTokens.ts`
- Test: `test/access/passwordTokens.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `sha256Hex` (crypto.ts).
- Produces: type `TokenPurpose = "invite" | "reset"`; `issueToken(db, email, purpose): Promise<string>` (raw token); `peekToken(db, token): Promise<{ email: string; purpose: TokenPurpose } | null>` (validate without consuming, for GET); `consumeToken(db, token): Promise<{ email: string; purpose: TokenPurpose } | null>` (single-use, atomic).

- [ ] **Step 1: Write the failing test**

```ts
// test/access/passwordTokens.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { issueToken, peekToken, consumeToken } from "../../src/access/passwordTokens";

const EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("password tokens", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM password_tokens").run();
  });

  it("peek validates without consuming; consume works once", async () => {
    const token = await issueToken(env.DB, EMAIL, "invite");
    expect(await peekToken(env.DB, token)).toEqual({ email: EMAIL, purpose: "invite" });
    expect(await consumeToken(env.DB, token)).toEqual({ email: EMAIL, purpose: "invite" });
    expect(await consumeToken(env.DB, token)).toBeNull(); // already used
    expect(await peekToken(env.DB, token)).toBeNull();
  });

  it("returns null for unknown and expired tokens", async () => {
    expect(await consumeToken(env.DB, "nope")).toBeNull();
    const token = await issueToken(env.DB, EMAIL, "reset");
    await env.DB.prepare("UPDATE password_tokens SET expires_at = 1 WHERE email = ?").bind(EMAIL).run();
    expect(await peekToken(env.DB, token)).toBeNull();
    expect(await consumeToken(env.DB, token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/access/passwordTokens.test.ts`
Expected: FAIL — cannot find module `src/access/passwordTokens`.

- [ ] **Step 3: Write the implementation**

```ts
// src/access/passwordTokens.ts
import { randomToken, sha256Hex } from "./crypto";

export type TokenPurpose = "invite" | "reset";

const TTL_MS: Record<TokenPurpose, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

export async function issueToken(db: D1Database, email: string, purpose: TokenPurpose): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await db
    .prepare("INSERT INTO password_tokens (token_hash, email, purpose, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
    .bind(tokenHash, email, purpose, now, now + TTL_MS[purpose])
    .run();
  return token;
}

async function readValid(db: D1Database, token: string) {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT email, purpose, expires_at, used_at FROM password_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ email: string; purpose: TokenPurpose; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at !== null || row.expires_at < Date.now()) return null;
  return { tokenHash, email: row.email, purpose: row.purpose };
}

export async function peekToken(db: D1Database, token: string): Promise<{ email: string; purpose: TokenPurpose } | null> {
  const r = await readValid(db, token);
  return r ? { email: r.email, purpose: r.purpose } : null;
}

export async function consumeToken(db: D1Database, token: string): Promise<{ email: string; purpose: TokenPurpose } | null> {
  const r = await readValid(db, token);
  if (!r) return null;
  const res = await db
    .prepare("UPDATE password_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(Date.now(), r.tokenHash)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null; // lost a race; treat as consumed
  return { email: r.email, purpose: r.purpose };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/access/passwordTokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/access/passwordTokens.ts test/access/passwordTokens.test.ts
git commit -m "feat(auth): add single-use invite/reset password tokens"
```

---

### Task 13: SendGrid email client + templates

**Files:**
- Create: `src/email/sendgrid.ts`
- Test: `test/email/sendgrid.test.ts`

**Interfaces:**
- Produces: `sendEmail(env, msg: { to: string; subject: string; html: string }): Promise<void>` (throws on non-2xx or missing config); `inviteEmail(link: string): { subject: string; html: string }`; `resetEmail(link: string): { subject: string; html: string }`. Env: `{ SENDGRID_API_KEY?: string; AUTH_FROM_EMAIL?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/email/sendgrid.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail, inviteEmail, resetEmail } from "../../src/email/sendgrid";

const ENV = { SENDGRID_API_KEY: "SG.test", AUTH_FROM_EMAIL: "no-reply@tcbpestcontrolcanberra.com.au" };

describe("sendgrid client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the SendGrid API with auth + payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail(ENV, { to: "jake@example.com", subject: "Hi", html: "<p>Hi</p>" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer SG.test" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.personalizations[0].to[0].email).toBe("jake@example.com");
    expect(body.from.email).toBe(ENV.AUTH_FROM_EMAIL);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 401 })));
    await expect(sendEmail(ENV, { to: "x@y.com", subject: "s", html: "h" })).rejects.toThrow(/401/);
  });

  it("throws when config is missing", async () => {
    await expect(sendEmail({}, { to: "x@y.com", subject: "s", html: "h" })).rejects.toThrow(/not configured/);
  });

  it("templates embed the link", () => {
    expect(inviteEmail("https://x/set-password?token=abc").html).toContain("https://x/set-password?token=abc");
    expect(resetEmail("https://x/set-password?token=def").html).toContain("https://x/set-password?token=def");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/email/sendgrid.test.ts`
Expected: FAIL — cannot find module `src/email/sendgrid`.

- [ ] **Step 3: Write the implementation**

```ts
// src/email/sendgrid.ts
type Env = { SENDGRID_API_KEY?: string; AUTH_FROM_EMAIL?: string };

export async function sendEmail(env: Env, msg: { to: string; subject: string; html: string }): Promise<void> {
  if (!env.SENDGRID_API_KEY || !env.AUTH_FROM_EMAIL) {
    throw new Error("email not configured: SENDGRID_API_KEY / AUTH_FROM_EMAIL missing");
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: env.AUTH_FROM_EMAIL, name: "TCB VoIP" },
      subject: msg.subject,
      content: [{ type: "text/html", value: msg.html }],
    }),
  });
  if (!res.ok) throw new Error(`sendgrid ${res.status}: ${await res.text()}`);
}

function wrap(heading: string, intro: string, link: string, cta: string): string {
  return `<div style="font-family:system-ui,sans-serif;background:#0f1013;color:#eceef2;padding:28px;">
    <div style="max-width:420px;margin:0 auto;background:#1b1d24;border:1px solid #26282f;border-radius:12px;padding:24px;">
      <div style="font-weight:700;margin-bottom:14px;">TCB VoIP</div>
      <h2 style="font-size:16px;margin:0 0 8px;">${heading}</h2>
      <p style="color:#a7adb8;font-size:13px;line-height:1.5;margin:0 0 18px;">${intro}</p>
      <a href="${link}" style="display:inline-block;background:#e4002b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:13px;">${cta}</a>
      <p style="color:#6d7280;font-size:11px;margin-top:18px;">If the button doesn't work, paste this link into your browser:<br>${link}</p>
    </div>
  </div>`;
}

export function inviteEmail(link: string): { subject: string; html: string } {
  return {
    subject: "You've been added to TCB VoIP — set your password",
    html: wrap("Set your password", "You've been added to the TCB VoIP dashboard. Choose a password to sign in. This link expires in 7 days.", link, "Set password"),
  };
}

export function resetEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Reset your TCB VoIP password",
    html: wrap("Reset your password", "We received a request to reset your TCB VoIP password. This link expires in 1 hour. If you didn't ask for this, you can ignore this email.", link, "Reset password"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/email/sendgrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/email/sendgrid.ts test/email/sendgrid.test.ts
git commit -m "feat(auth): add SendGrid email client + invite/reset templates"
```

---

### Task 14: `/forgot-password` + `/set-password` routes

**Files:**
- Modify: `src/api/auth.ts` (add four handlers)
- Modify: `src/worker.ts` (wire routes + add email env fields to `Env`)
- Test: `test/api/authReset.test.ts`

**Interfaces:**
- Consumes: `issueToken`, `peekToken`, `consumeToken` (passwordTokens.ts); `sendEmail`, `resetEmail` (sendgrid.ts); `hashPassword` (password.ts); `destroySessionsForEmail`, `createSession`, `sessionCookieHeader` (session.ts); `renderForgotPasswordPage`, `renderSetPasswordPage`, `renderAuthMessagePage` (login.ts).
- Produces: `handleForgotPasswordPage(request, env)`, `handleForgotPasswordSubmit(request, env, origin: string)`, `handleSetPasswordPage(request, env)`, `handleSetPasswordSubmit(request, env)`. Env now also includes `{ SENDGRID_API_KEY?; AUTH_FROM_EMAIL? }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/authReset.test.ts
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueToken } from "../../src/access/passwordTokens";
import { hashPassword } from "../../src/access/password";

const EMAIL = "resetme@example.com";

describe("forgot/set password routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(EMAIL).run();
    await env.DB.prepare("DELETE FROM password_tokens").run();
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(EMAIL).run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POST /forgot-password always returns the neutral 'check your email' page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
    env.SENDGRID_API_KEY = "SG.test";
    env.AUTH_FROM_EMAIL = "no-reply@tcbpestcontrolcanberra.com.au";
    for (const email of [EMAIL, "nobody@example.com"]) {
      const res = await SELF.fetch("https://example.com/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }).toString(),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("we've sent");
    }
  });

  it("GET /set-password with a valid token shows the form; invalid shows a message", async () => {
    const token = await issueToken(env.DB, EMAIL, "invite");
    const ok = await SELF.fetch(`https://example.com/set-password?token=${token}`);
    expect(await ok.text()).toContain('name="password"');
    const bad = await SELF.fetch("https://example.com/set-password?token=bogus");
    expect(await bad.text()).toContain("link");
  });

  it("POST /set-password sets the password, consumes token, and signs in", async () => {
    const token = await issueToken(env.DB, EMAIL, "invite");
    const res = await SELF.fetch("https://example.com/set-password", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password: "brandnewpass10", confirm: "brandnewpass10" }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie") ?? "").toContain("tcb_session=");
    const row = await env.DB.prepare("SELECT password_hash FROM staff_users WHERE email = ?").bind(EMAIL).first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$/);
  });

  it("POST /set-password rejects mismatched or short passwords", async () => {
    const token = await issueToken(env.DB, EMAIL, "reset");
    const res = await SELF.fetch("https://example.com/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, password: "short", confirm: "short" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("10 characters");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/authReset.test.ts`
Expected: FAIL — routes not wired (404 / wrong body).

- [ ] **Step 3: Add handlers to `src/api/auth.ts`**

Add these imports at the top of `src/api/auth.ts`:

```ts
import { issueToken, peekToken, consumeToken } from "../access/passwordTokens";
import { sendEmail, resetEmail } from "../email/sendgrid";
import { hashPassword } from "../access/password";
import { destroySessionsForEmail } from "../access/session";
import { renderForgotPasswordPage, renderSetPasswordPage, renderAuthMessagePage } from "../html/pages/login";
```

Extend the `Env` type in `src/api/auth.ts`:

```ts
type Env = {
  DB: D1Database;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  SENDGRID_API_KEY?: string;
  AUTH_FROM_EMAIL?: string;
};
```

Append the handlers:

```ts
export async function handleForgotPasswordPage(_request: Request, _env: Env): Promise<Response> {
  return html(renderForgotPasswordPage());
}

export async function handleForgotPasswordSubmit(request: Request, env: Env, origin: string): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // Neutral response regardless of existence. Only send if the account actually exists.
  if (email) {
    const user = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(email).first<{ email: string }>();
    if (user) {
      try {
        const token = await issueToken(env.DB, user.email, "reset");
        const link = `${origin}/set-password?token=${token}`;
        const { subject, html: body } = resetEmail(link);
        await sendEmail(env, { to: user.email, subject, html: body });
      } catch {
        // Swallow: never reveal existence or transport errors on this endpoint.
      }
    }
  }
  return html(renderForgotPasswordPage({ done: true }));
}

export async function handleSetPasswordPage(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const info = token ? await peekToken(env.DB, token) : null;
  if (!info) {
    return html(renderAuthMessagePage({ title: "Link expired", message: "This password link is invalid or has expired. Request a new one." }), 400);
  }
  return html(renderSetPasswordPage({ token, email: info.email }));
}

export async function handleSetPasswordSubmit(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  const info = token ? await peekToken(env.DB, token) : null;
  if (!info) {
    return html(renderAuthMessagePage({ title: "Link expired", message: "This password link is invalid or has expired. Request a new one." }), 400);
  }
  if (password.length < 10) {
    return html(renderSetPasswordPage({ token, email: info.email, error: "Password must be at least 10 characters." }), 400);
  }
  if (password !== confirm) {
    return html(renderSetPasswordPage({ token, email: info.email, error: "Passwords do not match." }), 400);
  }

  const consumed = await consumeToken(env.DB, token);
  if (!consumed) {
    return html(renderAuthMessagePage({ title: "Link expired", message: "This password link is invalid or has expired. Request a new one." }), 400);
  }

  const hash = await hashPassword(password);
  await env.DB.prepare("UPDATE staff_users SET password_hash = ?, password_set_at = ? WHERE email = ?")
    .bind(hash, Date.now(), consumed.email)
    .run();
  // Defense in depth: a reset invalidates any existing sessions.
  await destroySessionsForEmail(env.DB, consumed.email);

  const session = await createSession(env.DB, consumed.email);
  return new Response(null, { status: 302, headers: { Location: "/admin/live", "Set-Cookie": sessionCookieHeader(session) } });
}
```

Note: `createSession` and `sessionCookieHeader` are already imported in `src/api/auth.ts` from Task 8 — do not re-import.

- [ ] **Step 4: Wire routes in `src/worker.ts`**

Extend the import from `./api/auth`:

```ts
import {
  handleLoginPage, handleLoginSubmit, handleLogout,
  handleForgotPasswordPage, handleForgotPasswordSubmit,
  handleSetPasswordPage, handleSetPasswordSubmit,
} from "./api/auth";
```

Add `SENDGRID_API_KEY?` and `AUTH_FROM_EMAIL?` to the worker's `Env` type (near the other optional vars, `src/worker.ts:59`):

```ts
  SENDGRID_API_KEY?: string;
  AUTH_FROM_EMAIL?: string;
```

Add routes next to the `/login` + `/logout` block:

```ts
    if (url.pathname === "/forgot-password") {
      if (request.method === "GET") return handleForgotPasswordPage(request, env);
      if (request.method === "POST") return handleForgotPasswordSubmit(request, env, url.origin);
    }

    if (url.pathname === "/set-password") {
      if (request.method === "GET") return handleSetPasswordPage(request, env);
      if (request.method === "POST") return handleSetPasswordSubmit(request, env);
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/api/authReset.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/auth.ts src/worker.ts test/api/authReset.test.ts
git commit -m "feat(auth): add forgot-password + set-password flows"
```

---

### Task 15: Staff-admin API — invite / resend / reset / remove

**Files:**
- Modify: `src/api/staff.ts` (add four handlers)
- Modify: `src/db/staff.ts` (add `createInvitedStaff`, `deleteStaff`, `listStaffAccess`)
- Modify: `src/worker.ts` (wire routes in the `/api/staff` area)
- Test: `test/api/staffAdmin.test.ts`

**Interfaces:**
- Consumes: `issueToken` (passwordTokens.ts); `sendEmail`, `inviteEmail`, `resetEmail` (sendgrid.ts); `destroySessionsForEmail` (session.ts); `StaffUser` (requireStaffUser.ts).
- Produces (db/staff.ts): `createInvitedStaff(db, email, role): Promise<void>` (INSERT OR IGNORE, defaults from schema), `deleteStaff(db, email): Promise<void>`, `listStaffAccess(db): Promise<{ email: string; role: "admin"|"staff"; hasPassword: boolean }[]>`.
- Produces (api/staff.ts): `handleInviteStaff(request, env, staff, origin)`, `handleResendInvite(request, env, staff, email, origin)`, `handleSendReset(request, env, staff, email, origin)`, `handleRemoveStaff(env, staff, email)`. All admin-only (403 otherwise). Env: `{ DB; SENDGRID_API_KEY?; AUTH_FROM_EMAIL? }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/api/staffAdmin.test.ts
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pool authenticates every SELF.fetch as phill (admin) via AUTH_MODE=dev.
const NEW = "invitee@example.com";

describe("staff admin API", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(NEW).run();
    await env.DB.prepare("DELETE FROM password_tokens").run();
    env.SENDGRID_API_KEY = "SG.test";
    env.AUTH_FROM_EMAIL = "no-reply@tcbpestcontrolcanberra.com.au";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POST /api/staff invites: creates row (no password) and issues an invite token", async () => {
    const res = await SELF.fetch("https://example.com/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NEW, role: "staff" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT role, password_hash FROM staff_users WHERE email = ?").bind(NEW).first<{ role: string; password_hash: string | null }>();
    expect(row).toMatchObject({ role: "staff", password_hash: null });
    const tok = await env.DB.prepare("SELECT purpose FROM password_tokens WHERE email = ?").bind(NEW).first<{ purpose: string }>();
    expect(tok?.purpose).toBe("invite");
  });

  it("DELETE /api/staff/:email removes the user and their sessions", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(NEW).run();
    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent(NEW)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(NEW).first();
    expect(row).toBeNull();
  });

  it("DELETE /api/staff/:self is refused", async () => {
    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent("phill@tcbpestcontrolcanberra.com.au")}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("POST /api/staff/:email/reset issues a reset token", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1)").bind(NEW).run();
    const res = await SELF.fetch(`https://example.com/api/staff/${encodeURIComponent(NEW)}/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const tok = await env.DB.prepare("SELECT purpose FROM password_tokens WHERE email = ?").bind(NEW).first<{ purpose: string }>();
    expect(tok?.purpose).toBe("reset");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/staffAdmin.test.ts`
Expected: FAIL — routes not wired (404).

- [ ] **Step 3: Add DB helpers to `src/db/staff.ts`**

```ts
// append to src/db/staff.ts
export async function createInvitedStaff(db: D1Database, email: string, role: "admin" | "staff"): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO staff_users (email, role, created_at) VALUES (?, ?, ?)")
    .bind(email, role, Date.now())
    .run();
}

export async function deleteStaff(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM staff_users WHERE email = ?").bind(email).run();
}

export async function listStaffAccess(
  db: D1Database
): Promise<{ email: string; role: "admin" | "staff"; hasPassword: boolean }[]> {
  const rows = await db
    .prepare("SELECT email, role, password_hash FROM staff_users ORDER BY email")
    .all<{ email: string; role: "admin" | "staff"; password_hash: string | null }>();
  return rows.results.map((r) => ({ email: r.email, role: r.role, hasPassword: r.password_hash !== null }));
}
```

- [ ] **Step 4: Add handlers to `src/api/staff.ts`**

Add imports at the top:

```ts
import { issueToken } from "../access/passwordTokens";
import { sendEmail, inviteEmail, resetEmail } from "../email/sendgrid";
import { destroySessionsForEmail } from "../access/session";
import { createInvitedStaff, deleteStaff } from "../db/staff";
```

Add a local Env type and handlers:

```ts
type StaffAdminEnv = { DB: D1Database; SENDGRID_API_KEY?: string; AUTH_FROM_EMAIL?: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function handleInviteStaff(request: Request, env: StaffAdminEnv, staff: StaffUser, origin: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: { email?: unknown; role?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; role?: unknown };
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = body.role === "admin" ? "admin" : "staff";
  if (!EMAIL_RE.test(email)) return jsonResponse({ error: "Enter a valid email address." }, 400);

  await createInvitedStaff(env.DB, email, role);
  const token = await issueToken(env.DB, email, "invite");
  const { subject, html } = inviteEmail(`${origin}/set-password?token=${token}`);
  try {
    await sendEmail(env, { to: email, subject, html });
  } catch (e) {
    return jsonResponse({ error: "User created, but the invite email failed to send. Use 'Resend invite'.", detail: String(e) }, 502);
  }
  return jsonResponse({ ok: true });
}

export async function handleResendInvite(env: StaffAdminEnv, staff: StaffUser, email: string, origin: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  const user = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(email).first<{ email: string }>();
  if (!user) return jsonResponse({ error: "No such staff member." }, 404);
  const token = await issueToken(env.DB, user.email, "invite");
  const { subject, html } = inviteEmail(`${origin}/set-password?token=${token}`);
  try {
    await sendEmail(env, { to: user.email, subject, html });
  } catch (e) {
    return jsonResponse({ error: "Failed to send invite email.", detail: String(e) }, 502);
  }
  return jsonResponse({ ok: true });
}

export async function handleSendReset(env: StaffAdminEnv, staff: StaffUser, email: string, origin: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  const user = await env.DB.prepare("SELECT email FROM staff_users WHERE email = ?").bind(email).first<{ email: string }>();
  if (!user) return jsonResponse({ error: "No such staff member." }, 404);
  const token = await issueToken(env.DB, user.email, "reset");
  const { subject, html } = resetEmail(`${origin}/set-password?token=${token}`);
  try {
    await sendEmail(env, { to: user.email, subject, html });
  } catch (e) {
    return jsonResponse({ error: "Failed to send reset email.", detail: String(e) }, 502);
  }
  return jsonResponse({ ok: true });
}

export async function handleRemoveStaff(env: StaffAdminEnv, staff: StaffUser, email: string): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  if (email.toLowerCase() === staff.email.toLowerCase()) {
    return jsonResponse({ error: "You can't remove your own account." }, 400);
  }
  await deleteStaff(env.DB, email);
  await destroySessionsForEmail(env.DB, email);
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 5: Wire routes in `src/worker.ts`**

Update the `./api/staff` import:

```ts
import {
  handleGetStaffRoster, handlePutStaffSchedule, handlePutStaffPriority,
  handleInviteStaff, handleResendInvite, handleSendReset, handleRemoveStaff,
} from "./api/staff";
```

In the `/api/` block, replace the existing `GET /api/staff` handler with GET+POST and add the sub-routes. Find the block at `src/worker.ts:612` and change it to:

```ts
      if (url.pathname === "/api/staff") {
        if (request.method === "GET") return handleGetStaffRoster(env.DB);
        if (request.method === "POST") return handleInviteStaff(request, env, staff, url.origin);
      }
      const staffInviteMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/invite$/);
      if (staffInviteMatch && request.method === "POST") {
        return handleResendInvite(env, staff, decodeURIComponent(staffInviteMatch[1]).toLowerCase(), url.origin);
      }
      const staffResetMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/reset$/);
      if (staffResetMatch && request.method === "POST") {
        return handleSendReset(env, staff, decodeURIComponent(staffResetMatch[1]).toLowerCase(), url.origin);
      }
      const staffRemoveMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
      if (staffRemoveMatch && request.method === "DELETE") {
        return handleRemoveStaff(env, staff, decodeURIComponent(staffRemoveMatch[1]).toLowerCase());
      }
```

Note: the existing `/schedule` and `/priority` PUT matchers stay as-is below this; the `[^/]+$` remove-matcher only matches DELETE and terminates at the email segment, so it doesn't shadow the longer `/schedule`, `/priority`, `/invite`, `/reset` paths.

- [ ] **Step 6: Run test + full suite**

Run: `npx vitest run test/api/staffAdmin.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/staff.ts src/db/staff.ts src/worker.ts test/api/staffAdmin.test.ts
git commit -m "feat(auth): staff-admin API (invite/resend/reset/remove)"
```

---

### Task 16: Settings page — "Staff access" section

**Files:**
- Modify: `src/html/pages/settings.ts` (add a Staff access section, admin-only)
- Modify: `src/worker.ts` (`/admin/settings` handler passes the access list + current role)
- Test: `test/html/settingsStaffAccess.test.ts`

**Interfaces:**
- Consumes: `listStaffAccess` (db/staff.ts).
- Produces: `renderSettingsPage(...)` gains a trailing param `staffAccess: { email: string; role: string; hasPassword: boolean }[]` and `currentRole: "admin"|"staff"`; renders the section only when `currentRole === "admin"`. (Check the current `renderSettingsPage` signature in `src/html/pages/settings.ts` and append the two params at the end.)

- [ ] **Step 1: Read the current settings renderer signature**

Run: `sed -n '1,40p' src/html/pages/settings.ts`
Expected: note the exact `renderSettingsPage(...)` parameter list so the two new params are appended in order (do not reorder existing params).

- [ ] **Step 2: Write the failing test**

```ts
// test/html/settingsStaffAccess.test.ts
import { describe, expect, it } from "vitest";
import { renderSettingsPage } from "../../src/html/pages/settings";

// Build the leading args to match the CURRENT signature, then the two new trailing args.
// Replace `...leadingArgs` with the real leading arguments observed in Step 1.
const leadingArgs: any[] = [/* schedule */ {}, /* blocklist */ [], /* staffRoster */ []];

describe("settings staff access section", () => {
  it("admins see an invite control and the staff list with status", () => {
    const html = renderSettingsPage(
      ...leadingArgs,
      [{ email: "jake@example.com", role: "staff", hasPassword: false }],
      "admin"
    );
    expect(html).toContain("Staff access");
    expect(html).toContain("jake@example.com");
    expect(html).toContain("Invite");
    expect(html).toContain("Invited"); // status label for hasPassword=false
  });

  it("non-admins do not see the staff access section", () => {
    const html = renderSettingsPage(...leadingArgs, [], "staff");
    expect(html).not.toContain("Staff access");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/html/settingsStaffAccess.test.ts`
Expected: FAIL — `renderSettingsPage` ignores the new args / section absent.

- [ ] **Step 4: Implement the section in `src/html/pages/settings.ts`**

Append two params to `renderSettingsPage` (keep existing params first). Inside the function, build the section and include it in the returned body:

```ts
// import at top of settings.ts, alongside existing imports:
import { escapeHtml } from "../layout";

// helper — place above renderSettingsPage:
function renderStaffAccess(
  staffAccess: { email: string; role: string; hasPassword: boolean }[]
): string {
  const rows = staffAccess
    .map((s) => {
      const status = s.hasPassword
        ? '<span class="badge">Active</span>'
        : '<span class="badge badge-after-hours">Invited</span>';
      const e = escapeHtml(s.email);
      return `<tr data-email="${e}">
        <td>${e}</td><td>${escapeHtml(s.role)}</td><td>${status}</td>
        <td style="white-space:nowrap;">
          <button type="button" onclick="staffAction('${e}','reset')">Send reset</button>
          <button type="button" onclick="staffAction('${e}','invite')">Resend invite</button>
          <button type="button" onclick="staffRemove('${e}')">Remove</button>
        </td></tr>`;
    })
    .join("");

  return `<form class="settings-form" onsubmit="return false">
    <h3>Staff access</h3>
    <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.9rem;flex-wrap:wrap;">
      <input id="invite-email" type="email" placeholder="new.staff@tcbpestcontrolcanberra.com.au" style="flex:1;min-width:220px;">
      <select id="invite-role"><option value="staff">Staff</option><option value="admin">Admin</option></select>
      <button type="button" onclick="inviteStaff()">Invite</button>
    </div>
    <table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p id="staff-msg" class="placeholder" style="display:none;"></p>
    <script>
      function staffMsg(t){var el=document.getElementById('staff-msg');el.textContent=t;el.style.display='block';}
      async function inviteStaff(){
        var email=document.getElementById('invite-email').value.trim();
        var role=document.getElementById('invite-role').value;
        if(!email)return staffMsg('Enter an email.');
        var r=await fetch('/api/staff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,role:role})});
        var d=await r.json().catch(function(){return {};});
        if(r.ok){location.reload();}else{staffMsg(d.error||'Invite failed.');}
      }
      async function staffAction(email,kind){
        var r=await fetch('/api/staff/'+encodeURIComponent(email)+'/'+kind,{method:'POST'});
        var d=await r.json().catch(function(){return {};});
        staffMsg(r.ok?(kind==='reset'?'Reset link sent.':'Invite resent.'):(d.error||'Failed.'));
      }
      async function staffRemove(email){
        if(!confirm('Remove '+email+'?'))return;
        var r=await fetch('/api/staff/'+encodeURIComponent(email),{method:'DELETE'});
        var d=await r.json().catch(function(){return {};});
        if(r.ok){location.reload();}else{staffMsg(d.error||'Remove failed.');}
      }
    </script>
  </form>`;
}
```

In `renderSettingsPage`, add the new params to the signature and inject the section (only for admins) into the page body — e.g. append `${currentRole === "admin" ? renderStaffAccess(staffAccess) : ""}` to the existing body string before it's passed to `renderLayout`.

- [ ] **Step 5: Update the `/admin/settings` handler in `src/worker.ts`**

Add the import:

```ts
import { getStaffRoster, listStaffAccess } from "./db/staff";
```

(`getStaffRoster` is already imported — merge, don't duplicate.) Then update the handler at `src/worker.ts:677`:

```ts
      if (url.pathname === "/admin/settings") {
        const [schedule, blocklist, staffRoster, staffAccess] = await Promise.all([
          getBusinessHours(env.DB),
          getCallBlocklist(env.DB),
          getStaffRoster(env.DB),
          listStaffAccess(env.DB),
        ]);
        const html = renderSettingsPage(schedule, blocklist, staffRoster, staffAccess, staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
```

- [ ] **Step 6: Run test + full suite**

Run: `npx vitest run test/html/settingsStaffAccess.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/html/pages/settings.ts src/worker.ts test/html/settingsStaffAccess.test.ts
git commit -m "feat(auth): Settings → Staff access (invite/reset/remove UI)"
```

---

### Task 17: Phase 2 config + docs

**Files:**
- Modify: `wrangler.jsonc` (add `AUTH_FROM_EMAIL` var)
- Modify: `README.md` (document auth, secrets, break-glass, cutover)

**Interfaces:** none.

- [ ] **Step 1: Add the `AUTH_FROM_EMAIL` var to `wrangler.jsonc`**

```jsonc
  "vars": {
    "TWILIO_FROM_NUMBER": "+61866108941",
    "TWILIO_TWIML_APP_SID": "AP37a6e4263508806aa37efaf19285d2ed",
    "AUTH_FROM_EMAIL": "no-reply@tcbpestcontrolcanberra.com.au"
  }
```

- [ ] **Step 2: Set the SendGrid secret (runtime step, documented)**

Document (and run when deploying):

```bash
npx wrangler secret put SENDGRID_API_KEY
```

- [ ] **Step 3: Add a README "Authentication" section**

Add a section covering: sessions are cookie-based (12h); invite/reset via SendGrid (`SENDGRID_API_KEY` secret + `AUTH_FROM_EMAIL` var + verified sender on the domain); the break-glass script (`node scripts/set-password.mjs <email> <pass>` → `wrangler d1 execute`); and a pointer to `docs/superpowers/runbooks/auth-cutover.md`. Note that `AUTH_MODE=dev` + `DEV_STAFF_EMAIL` is local-dev only.

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc README.md
git commit -m "docs(auth): document secrets, break-glass, cutover; add AUTH_FROM_EMAIL"
```

---

## Self-Review

**Spec coverage:**
- Remove Cloudflare Access → Tasks 6, 10, 11 (runbook). ✅
- Data model (password cols, sessions, password_tokens, login_attempts) → Task 1. ✅
- PBKDF2 hashing + dummy-hash timing defense → Tasks 3, 8. ✅
- Sessions + cookie flags → Task 4; used in 6, 8, 14. ✅
- Tokens (invite/reset, single-use, TTLs) → Task 12. ✅
- SendGrid client + templates → Task 13. ✅
- Routes: /login, /logout → Task 8; /forgot-password, /set-password → Task 14. ✅
- requireStaffUser rewrite + isApi contract (302 page / 401 api) → Task 6. ✅
- Staff-admin API + Settings UI → Tasks 15, 16. ✅
- Rate limiting → Task 5; wired in Task 8. ✅
- Break-glass bootstrap → Task 9; verified cutover → Task 11. ✅
- No account enumeration (forgot-password neutral; login dummy verify) → Tasks 8, 14. ✅
- Config cleanup + AUTH_FROM_EMAIL/SENDGRID_API_KEY → Tasks 10, 17. ✅

**Placeholder scan:** No "TBD"/"TODO"/"handle edge cases" without code. Task 16 Step 1/4 deliberately reads the existing `renderSettingsPage` signature before editing because its current parameter list must be observed in-repo (it isn't quoted in the spec) — the two new trailing params and the injection point are fully specified.

**Type consistency:** `requireStaffUser(request, env, { isApi })` used identically in Task 6 and both Task 6 call-sites. `createSession`/`lookupSession`/`destroySession`/`destroySessionsForEmail`, `sessionCookieHeader`/`clearSessionCookieHeader`/`parseSessionCookie` names identical across Tasks 4/6/8/14/15. `issueToken`/`peekToken`/`consumeToken` identical across Tasks 12/14/15. `sendEmail(env, {to,subject,html})`, `inviteEmail(link)`, `resetEmail(link)` identical across Tasks 13/14/15. Hash format string identical in Tasks 3/9. `listStaffAccess` shape `{email, role, hasPassword}` identical across Tasks 15/16.

# Tenancy Foundation — Part 1: schema, scope, and the first scoped module

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every row in D1 an owning tenant, and make the data layer unreachable without proving which tenant you are acting for — proven end-to-end on the `messages` module.

**Architecture:** A `tenants` table plus a `tenant_channels` routing table map inbound addresses to a tenant. A `TenantScope` value (`{db, tenantId}`) replaces the bare `D1Database` in data functions; it can only be produced by three constructors, each of which throws on an empty tenant id. Production keeps exactly one tenant (`tnt_tcb`) and behaviour does not change.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), TypeScript, Vitest via `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-31-tenancy-foundation-design.md`. Read it before starting.
- **Tenant id for the existing business is `tnt_tcb`.** Never hardcode it anywhere except migration `0026`.
- **`tenant_id` columns are `TEXT NOT NULL DEFAULT ''`.** The empty-string default is deliberate and fail-closed. Do not change it to default to a real tenant.
- **15 tenant-scoped tables:** `call_events`, `callback_requests`, `calls`, `contacts`, `fb_contacts`, `fb_name_attempts`, `ivr_audio_assets`, `ivr_nodes`, `messages`, `phone_numbers`, `push_tokens`, `settings`, `softphone_call_legs`, `staff_users`, `user_settings`.
- **3 global tables, never scoped:** `sessions`, `login_attempts`, `password_tokens`.
- Next migration number is **0026**. Check `ls migrations/` first — another session may have taken it.
- Run `npx tsc --noEmit; echo $?` to typecheck. Never pipe it into `head` — a pipe swallows the exit code.
- Full test suite: `npx vitest run`. Baseline before starting is **61 files / 520 tests passing**.
- Do not deploy. Production rollout is Part 3.

---

### Task 1: Migration — tenants, routing table, and tenant_id everywhere

**Files:**
- Create: `migrations/0026_tenancy.sql`
- Test: `test/db/tenancy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `tenants(id, name, status, created_at)` and `tenant_channels(address, tenant_id, kind)`; a `tenant_id TEXT NOT NULL DEFAULT ''` column on each of the 15 scoped tables; the seeded tenant `tnt_tcb`.

**Why `tenant_channels` rather than reusing `phone_numbers`:** inbound webhooks arrive addressed to a phone number *or* to `messenger:626021143926639`, and the Messenger address is not in `phone_numbers` (verified against production — that table holds only the two E.164 numbers). Routing also wants a different lifecycle from the user-facing number-management table. One table, one job.

- [ ] **Step 1: Write the failing test**

Create `test/db/tenancy.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const SCOPED_TABLES = [
  "call_events", "callback_requests", "calls", "contacts", "fb_contacts",
  "fb_name_attempts", "ivr_audio_assets", "ivr_nodes", "messages", "phone_numbers",
  "push_tokens", "settings", "softphone_call_legs", "staff_users", "user_settings",
];

const GLOBAL_TABLES = ["sessions", "login_attempts", "password_tokens"];

describe("tenancy migration", () => {
  it("creates the tenants table with the existing business seeded", async () => {
    const row = await env.DB.prepare("SELECT id, name, status FROM tenants WHERE id = 'tnt_tcb'")
      .first<{ id: string; name: string; status: string }>();
    expect(row?.status).toBe("active");
  });

  it("routes every address the business actually receives on", async () => {
    const rows = await env.DB.prepare("SELECT address, tenant_id, kind FROM tenant_channels ORDER BY address")
      .all<{ address: string; tenant_id: string; kind: string }>();
    expect(rows.results.map((r) => r.address)).toEqual([
      "+61485034869",
      "+61866108941",
      "messenger:626021143926639",
    ]);
    expect(rows.results.every((r) => r.tenant_id === "tnt_tcb")).toBe(true);
  });

  it("adds tenant_id to every scoped table", async () => {
    for (const table of SCOPED_TABLES) {
      const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(cols.results.map((c) => c.name)).toContain("tenant_id");
    }
  });

  it("leaves the pre-auth global tables unscoped", async () => {
    for (const table of GLOBAL_TABLES) {
      const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(cols.results.map((c) => c.name)).not.toContain("tenant_id");
    }
  });

  // The '' default is fail-closed: a row inserted without a tenant is orphaned, not misfiled.
  it("defaults tenant_id to the empty string, not to a real tenant", async () => {
    await env.DB.prepare(
      "INSERT INTO contacts (name, phone, phone_normalized, created_at, updated_at) VALUES ('No Tenant', '+61400111222', '+61400111222', 1, 1)"
    ).run();
    const row = await env.DB.prepare(
      "SELECT tenant_id FROM contacts WHERE phone_normalized = '+61400111222'"
    ).first<{ tenant_id: string }>();
    expect(row?.tenant_id).toBe("");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/db/tenancy.test.ts`
Expected: FAIL — `no such table: tenants`.

- [ ] **Step 3: Write the migration**

First confirm the number is free: `ls migrations/ | tail -3`. If `0026_*` exists, use the next free number and adjust the filename below.

Create `migrations/0026_tenancy.sql`:

```sql
-- Tenancy foundation. Every row gains an owning tenant so the product can serve more than one
-- business. Ships with exactly one tenant; behaviour does not change.
--
-- tenant_id defaults to '' ON PURPOSE. A row inserted without a tenant then matches no tenant and
-- is invisible to everyone, rather than being silently filed into the operating business's own
-- account where nobody would notice it. Fail-closed beats fail-quiet.

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'pending' | 'suspended'
  created_at INTEGER NOT NULL
);

INSERT INTO tenants (id, name, status, created_at)
VALUES ('tnt_tcb', 'TCB Pest Control Canberra', 'active', 1788200000000)
ON CONFLICT(id) DO NOTHING;

-- Routing: the address an inbound webhook is directed to -> the tenant that owns it. Covers phone
-- numbers and the Facebook Page's Messenger address, which is not a phone number and so cannot
-- live in phone_numbers.
CREATE TABLE IF NOT EXISTS tenant_channels (
  address   TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind      TEXT NOT NULL                      -- 'phone' | 'messenger'
);

INSERT INTO tenant_channels (address, tenant_id, kind) VALUES
  ('+61866108941',              'tnt_tcb', 'phone'),
  ('+61485034869',              'tnt_tcb', 'phone'),
  ('messenger:626021143926639', 'tnt_tcb', 'messenger')
ON CONFLICT(address) DO NOTHING;

ALTER TABLE call_events         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE callback_requests   ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE calls               ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts            ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE fb_contacts         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE fb_name_attempts    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ivr_audio_assets    ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ivr_nodes           ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages            ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE phone_numbers       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE push_tokens         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE settings            ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE softphone_call_legs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE staff_users         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_settings       ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';

UPDATE call_events         SET tenant_id = 'tnt_tcb';
UPDATE callback_requests   SET tenant_id = 'tnt_tcb';
UPDATE calls               SET tenant_id = 'tnt_tcb';
UPDATE contacts            SET tenant_id = 'tnt_tcb';
UPDATE fb_contacts         SET tenant_id = 'tnt_tcb';
UPDATE fb_name_attempts    SET tenant_id = 'tnt_tcb';
UPDATE ivr_audio_assets    SET tenant_id = 'tnt_tcb';
UPDATE ivr_nodes           SET tenant_id = 'tnt_tcb';
UPDATE messages            SET tenant_id = 'tnt_tcb';
UPDATE phone_numbers       SET tenant_id = 'tnt_tcb';
UPDATE push_tokens         SET tenant_id = 'tnt_tcb';
UPDATE settings            SET tenant_id = 'tnt_tcb';
UPDATE softphone_call_legs SET tenant_id = 'tnt_tcb';
UPDATE staff_users         SET tenant_id = 'tnt_tcb';
UPDATE user_settings       SET tenant_id = 'tnt_tcb';

-- Composite indexes for the paths that run on every request.
CREATE INDEX IF NOT EXISTS idx_messages_tenant_peer   ON messages (tenant_id, peer_number, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_tenant_started   ON calls (tenant_id, started_at);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone  ON contacts (tenant_id, phone_normalized);
CREATE INDEX IF NOT EXISTS idx_staff_tenant           ON staff_users (tenant_id);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/db/tenancy.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full suite for regressions**

Run: `npx vitest run`
Expected: 62 files, 525 tests passing. Existing tests are unaffected — every column is additive with a default.

- [ ] **Step 6: Commit**

```bash
git add migrations/0026_tenancy.sql test/db/tenancy.test.ts
git commit -m "feat(tenancy): tenant_id on every scoped table, plus routing"
```

---

### Task 2: The TenantScope type and its three constructors

**Files:**
- Create: `src/db/scope.ts`
- Test: `test/db/scope.test.ts`

**Interfaces:**
- Consumes: `tenants` and `tenant_channels` from Task 1.
- Produces:
  - `type TenantScope = { readonly db: D1Database; readonly tenantId: string }`
  - `scopeForTenantId(db: D1Database, tenantId: string): TenantScope` — throws on empty
  - `scopeForStaff(db: D1Database, staff: { tenantId: string }): TenantScope`
  - `scopeForAddress(db: D1Database, address: string): Promise<TenantScope | null>` — null when the address is unknown *or* its tenant is not active

- [ ] **Step 1: Write the failing test**

Create `test/db/scope.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { scopeForAddress, scopeForStaff, scopeForTenantId } from "../../src/db/scope";

describe("TenantScope", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tenants WHERE id <> 'tnt_tcb'").run();
    await env.DB.prepare("DELETE FROM tenant_channels WHERE tenant_id <> 'tnt_tcb'").run();
  });

  it("builds a scope from a tenant id", () => {
    expect(scopeForTenantId(env.DB, "tnt_tcb").tenantId).toBe("tnt_tcb");
  });

  // An empty tenant id is the fail-closed sentinel. Building a scope from it would hand back
  // every orphaned row in the database, so it must be impossible.
  it("refuses an empty tenant id", () => {
    expect(() => scopeForTenantId(env.DB, "")).toThrow(/tenant/i);
    expect(() => scopeForTenantId(env.DB, "   ")).toThrow(/tenant/i);
  });

  it("builds a scope from a signed-in staff user", () => {
    expect(scopeForStaff(env.DB, { tenantId: "tnt_tcb" }).tenantId).toBe("tnt_tcb");
  });

  it("resolves a phone number to its tenant", async () => {
    const scope = await scopeForAddress(env.DB, "+61866108941");
    expect(scope?.tenantId).toBe("tnt_tcb");
  });

  it("resolves the messenger address to its tenant", async () => {
    const scope = await scopeForAddress(env.DB, "messenger:626021143926639");
    expect(scope?.tenantId).toBe("tnt_tcb");
  });

  it("returns null for an address belonging to nobody", async () => {
    expect(await scopeForAddress(env.DB, "+61499999999")).toBeNull();
  });

  // A suspended tenant must stop receiving traffic without any caller having to remember to check.
  it("returns null when the owning tenant is not active", async () => {
    await env.DB.prepare(
      "INSERT INTO tenants (id, name, status, created_at) VALUES ('tnt_susp', 'Suspended Co', 'suspended', 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO tenant_channels (address, tenant_id, kind) VALUES ('+61411111111', 'tnt_susp', 'phone')"
    ).run();
    expect(await scopeForAddress(env.DB, "+61411111111")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/db/scope.test.ts`
Expected: FAIL — cannot resolve `../../src/db/scope`.

- [ ] **Step 3: Write the implementation**

Create `src/db/scope.ts`:

```ts
// Proof of which tenant a piece of work belongs to.
//
// Every function in src/db/ takes a TenantScope instead of a bare D1Database, so the data layer
// cannot be reached without first establishing whose data is being touched. D1/SQLite has no
// row-level security, so this is not a hard guarantee the way Postgres RLS would be -- it is the
// type system removing the "forgot to thread the tenant through" class of mistake, backed by the
// two-tenant isolation tests that catch a wrong WHERE clause.

export type TenantScope = { readonly db: D1Database; readonly tenantId: string };

// The only place a scope is constructed. An empty id is the fail-closed sentinel used by the
// migration default, so building a scope from it would match every orphaned row in the database.
export function scopeForTenantId(db: D1Database, tenantId: string): TenantScope {
  const id = (tenantId ?? "").trim();
  if (!id) throw new Error("TenantScope requires a non-empty tenant id");
  return { db, tenantId: id };
}

// Authenticated app requests: the session already told us who the user is.
export function scopeForStaff(db: D1Database, staff: { tenantId: string }): TenantScope {
  return scopeForTenantId(db, staff.tenantId);
}

// Inbound webhooks: unauthenticated, addressed to one of our numbers or the Page's Messenger
// address. This is the one lookup that legitimately runs outside a scope -- it reads only the
// routing mapping, and the Twilio signature check still gates everything that follows.
// Returns null for an unknown address or a tenant that is not active; callers answer 204.
export async function scopeForAddress(db: D1Database, address: string): Promise<TenantScope | null> {
  const key = (address ?? "").trim();
  if (!key) return null;
  const row = await db
    .prepare(
      `SELECT c.tenant_id AS tenant_id
         FROM tenant_channels c
         JOIN tenants t ON t.id = c.tenant_id
        WHERE c.address = ? AND t.status = 'active'`
    )
    .bind(key)
    .first<{ tenant_id: string }>();
  return row ? scopeForTenantId(db, row.tenant_id) : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/db/scope.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit; echo $?`
Expected: `TypeScript: No errors found` and `0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/scope.ts test/db/scope.test.ts
git commit -m "feat(tenancy): TenantScope and its three constructors"
```

---

### Task 3: Two-tenant test harness

**Files:**
- Create: `test/helpers/tenants.ts`
- Test: `test/helpers/tenants.test.ts`

**Interfaces:**
- Consumes: `scopeForTenantId` from Task 2.
- Produces:
  - `TENANT_A = "tnt_a"`, `TENANT_B = "tnt_b"`
  - `seedTenants(db: D1Database): Promise<{ a: TenantScope; b: TenantScope }>`
  - `resetTenants(db: D1Database): Promise<void>`
  - `COLLIDING_PEER = "+61400000000"` — the customer number both tenants talk to

**Why colliding data:** two businesses really can hold conversations with the same phone number — a shared supplier, or a wrong number. Isolation tests seeded with distinct data pass even when the tenant clause is missing, because there was nothing to confuse. The collision is what makes the test bite.

- [ ] **Step 1: Write the failing test**

Create `test/helpers/tenants.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COLLIDING_PEER, resetTenants, seedTenants, TENANT_A, TENANT_B } from "./tenants";

describe("two-tenant harness", () => {
  it("creates two active tenants with usable scopes", async () => {
    await resetTenants(env.DB);
    const { a, b } = await seedTenants(env.DB);
    expect(a.tenantId).toBe(TENANT_A);
    expect(b.tenantId).toBe(TENANT_B);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM tenants WHERE id IN (?, ?)"
    ).bind(TENANT_A, TENANT_B).first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("is safe to run twice", async () => {
    await resetTenants(env.DB);
    await seedTenants(env.DB);
    await seedTenants(env.DB);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM tenants WHERE id IN (?, ?)"
    ).bind(TENANT_A, TENANT_B).first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("offers one customer number that both tenants talk to", () => {
    expect(COLLIDING_PEER).toMatch(/^\+61/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/helpers/tenants.test.ts`
Expected: FAIL — cannot resolve `./tenants`.

- [ ] **Step 3: Write the helper**

Create `test/helpers/tenants.ts`:

```ts
import { scopeForTenantId, type TenantScope } from "../../src/db/scope";

export const TENANT_A = "tnt_a";
export const TENANT_B = "tnt_b";

// The same customer number, talked to by BOTH tenants. Isolation tests seeded with distinct data
// pass even when the tenant clause is missing; this collision is what actually catches a leak.
export const COLLIDING_PEER = "+61400000000";

export async function resetTenants(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM tenants WHERE id IN (?, ?)").bind(TENANT_A, TENANT_B).run();
  await db.prepare("DELETE FROM tenant_channels WHERE tenant_id IN (?, ?)").bind(TENANT_A, TENANT_B).run();
  await db.prepare("DELETE FROM messages WHERE tenant_id IN (?, ?)").bind(TENANT_A, TENANT_B).run();
}

export async function seedTenants(db: D1Database): Promise<{ a: TenantScope; b: TenantScope }> {
  for (const [id, name] of [[TENANT_A, "Tenant A"], [TENANT_B, "Tenant B"]] as const) {
    await db
      .prepare(
        "INSERT INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', 1) ON CONFLICT(id) DO NOTHING"
      )
      .bind(id, name)
      .run();
  }
  return { a: scopeForTenantId(db, TENANT_A), b: scopeForTenantId(db, TENANT_B) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/helpers/tenants.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/tenants.ts test/helpers/tenants.test.ts
git commit -m "test(tenancy): two-tenant harness with colliding fixtures"
```

---

### Task 4: requireStaffUser carries the tenant

**Files:**
- Modify: `src/access/requireStaffUser.ts`
- Test: `test/access/requireStaffUser.test.ts` (create if absent)

**Interfaces:**
- Consumes: `staff_users.tenant_id` from Task 1.
- Produces: `StaffUser` gains `tenantId: string`. Every existing consumer of `requireStaffUser` keeps compiling because the type only widens.

- [ ] **Step 1: Write the failing test**

Create `test/access/requireStaffUser.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { requireStaffUser } from "../../src/access/requireStaffUser";

// AUTH_MODE is "dev" in the test bindings, so the session lookup is bypassed and the user is
// DEV_STAFF_EMAIL. The tenant still has to come from that user's row.
const DEV_EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("requireStaffUser", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM staff_users WHERE email = ?").bind(DEV_EMAIL).run();
  });

  it("returns the tenant the staff user belongs to", async () => {
    await env.DB.prepare(
      "INSERT INTO staff_users (email, role, created_at, tenant_id) VALUES (?, 'admin', 1, 'tnt_tcb')"
    ).bind(DEV_EMAIL).run();

    const result = await requireStaffUser(new Request("https://x/api/me"), env, { isApi: true });
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({ email: DEV_EMAIL, role: "admin", tenantId: "tnt_tcb" });
  });

  // A staff row left orphaned by a bad insert must not become a skeleton key.
  it("refuses a staff user with no tenant", async () => {
    await env.DB.prepare(
      "INSERT INTO staff_users (email, role, created_at, tenant_id) VALUES (?, 'admin', 1, '')"
    ).bind(DEV_EMAIL).run();

    const result = await requireStaffUser(new Request("https://x/api/me"), env, { isApi: true });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/access/requireStaffUser.test.ts`
Expected: FAIL — `tenantId` is undefined on the returned object.

- [ ] **Step 3: Modify requireStaffUser**

In `src/access/requireStaffUser.ts`, change the exported type and the final query. Replace:

```ts
export type StaffUser = { email: string; role: "admin" | "staff" };
```

with:

```ts
export type StaffUser = { email: string; role: "admin" | "staff"; tenantId: string };
```

Replace the lookup and return at the end of the function:

```ts
  const row = await env.DB.prepare("SELECT email, role FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff" }>();

  if (!row) return new Response("not provisioned", { status: 403 });

  return { email: row.email, role: row.role };
```

with:

```ts
  const row = await env.DB.prepare("SELECT email, role, tenant_id FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff"; tenant_id: string }>();

  if (!row) return new Response("not provisioned", { status: 403 });
  // A staff row with no tenant is an orphan from a bad insert (see the '' default in migration
  // 0026). Treating it as unprovisioned is safer than letting it reach the data layer.
  if (!row.tenant_id) return new Response("not provisioned", { status: 403 });

  return { email: row.email, role: row.role, tenantId: row.tenant_id };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/access/requireStaffUser.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all green. Existing tests that build a `StaffUser` literal by hand will fail to typecheck — add `tenantId: "tnt_tcb"` to each. Find them with `npx tsc --noEmit`.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit; echo $?
git add src/access/requireStaffUser.ts test/access/requireStaffUser.test.ts
git commit -m "feat(tenancy): requireStaffUser resolves the caller's tenant"
```

---

### Task 5: Scope the messages module and its call sites

**Files:**
- Modify: `src/db/messages.ts` (all four exported functions)
- Modify: `src/api/messages.ts:28-37,73`
- Modify: `src/worker.ts:616` (inbound SMS/Messenger webhook), and the `/api/messages` routes
- Test: `test/db/messagesIsolation.test.ts` (create)
- Test: `test/db/messages.test.ts` (update existing calls)

**Interfaces:**
- Consumes: `TenantScope` (Task 2), `seedTenants` / `COLLIDING_PEER` (Task 3), `StaffUser.tenantId` (Task 4).
- Produces the new data-layer signatures:
  - `insertMessage(scope: TenantScope, m: {...unchanged fields...}): Promise<void>`
  - `listConversations(scope: TenantScope): Promise<ConversationRow[]>`
  - `listThread(scope: TenantScope, peer: string, limit?: number): Promise<MessageRow[]>`
  - `markThreadRead(scope: TenantScope, peer: string): Promise<void>`
- And the API-layer signatures:
  - `handleListConversations(scope: TenantScope): Promise<Response>`
  - `handleGetThread(scope: TenantScope, peer: string, peek?: boolean): Promise<Response>`
  - `handleSendMessage(request: Request, env: Env, scope: TenantScope): Promise<Response>`

**Watch out:** `listConversations` filters `messages` in **four** separate places in one statement — the outer select, the unread sub-select, the `latest` derived table, and the `fb_contacts` join. Missing any one of them leaks. This is the query that most justifies the whole exercise.

- [ ] **Step 1: Write the failing isolation test**

Create `test/db/messagesIsolation.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMessage, listConversations, listThread, markThreadRead } from "../../src/db/messages";
import { COLLIDING_PEER, resetTenants, seedTenants } from "../helpers/tenants";
import type { TenantScope } from "../../src/db/scope";

async function sendInbound(scope: TenantScope, id: string, body: string) {
  await insertMessage(scope, {
    id,
    direction: "inbound",
    peer_number: COLLIDING_PEER,
    our_number: "+61866108941",
    body,
    status: "received",
    read: 0,
    createdAt: Date.now(),
  });
}

describe("messages isolation", () => {
  let a: TenantScope;
  let b: TenantScope;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM messages").run();
    await resetTenants(env.DB);
    ({ a, b } = await seedTenants(env.DB));
  });

  it("stamps inserts with the scope's tenant", async () => {
    await sendInbound(a, "SM-a1", "for A");
    const row = await env.DB.prepare("SELECT tenant_id FROM messages WHERE id = 'SM-a1'")
      .first<{ tenant_id: string }>();
    expect(row?.tenant_id).toBe(a.tenantId);
  });

  // Both tenants talk to the SAME customer number. Without the tenant clause each would read the
  // other's conversation with that person.
  it("keeps threads with the same customer number apart", async () => {
    await sendInbound(a, "SM-a1", "for A");
    await sendInbound(b, "SM-b1", "for B");

    expect((await listThread(a, COLLIDING_PEER)).map((m) => m.body)).toEqual(["for A"]);
    expect((await listThread(b, COLLIDING_PEER)).map((m) => m.body)).toEqual(["for B"]);
  });

  it("shows each tenant only its own conversations", async () => {
    await sendInbound(a, "SM-a1", "for A");
    await sendInbound(b, "SM-b1", "for B");

    const convA = await listConversations(a);
    expect(convA).toHaveLength(1);
    expect(convA[0].last_body).toBe("for A");
    expect(convA[0].unread).toBe(1);
  });

  // The write case: marking A's thread read must not clear B's unread badge for the same number.
  it("does not mark another tenant's thread read", async () => {
    await sendInbound(a, "SM-a1", "for A");
    await sendInbound(b, "SM-b1", "for B");

    await markThreadRead(a, COLLIDING_PEER);

    expect((await listConversations(a))[0].unread).toBe(0);
    expect((await listConversations(b))[0].unread).toBe(1);
  });

  it("never writes an empty tenant_id", async () => {
    await sendInbound(a, "SM-a1", "for A");
    const orphan = await env.DB.prepare("SELECT COUNT(*) AS c FROM messages WHERE tenant_id = ''")
      .first<{ c: number }>();
    expect(orphan?.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/db/messagesIsolation.test.ts`
Expected: FAIL — `insertMessage` still expects a `D1Database`, so this fails to typecheck / passes a scope object where a db is expected.

- [ ] **Step 3: Rewrite src/db/messages.ts**

Replace the whole file body below the header comment. Keep the existing header comment and add a line about tenancy:

```ts
import type { TenantScope } from "./scope";

export type MessageRow = { id: string; direction: "inbound" | "outbound"; body: string; ts: number; status: string | null };
export type ConversationRow = { number: string; name: string | null; last_body: string; last_ts: number; unread: number };

export async function insertMessage(
  scope: TenantScope,
  m: {
    id: string;
    direction: "inbound" | "outbound";
    peer_number: string;
    our_number: string | null;
    body: string;
    status: string | null;
    read: number;
    createdAt: number;
  }
): Promise<void> {
  await scope.db
    .prepare(
      "INSERT INTO messages (id, tenant_id, direction, peer_number, our_number, body, status, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    )
    .bind(m.id, scope.tenantId, m.direction, m.peer_number, m.our_number, m.body, m.status, m.read, m.createdAt)
    .run();
}

// Latest message per conversation, newest first, with an unread (inbound, not yet viewed) count.
// The tenant appears FOUR times: the outer filter, the unread sub-select, the `latest` derived
// table, and the fb_contacts join. Every one is load-bearing -- drop any and this returns another
// business's conversations.
export async function listConversations(scope: TenantScope): Promise<ConversationRow[]> {
  const rows = await scope.db
    .prepare(
      `SELECT m.peer_number AS number, fb.name AS fb_name, m.body AS last_body, m.created_at AS last_ts,
         (SELECT COUNT(*) FROM messages u
           WHERE u.tenant_id = ? AND u.peer_number = m.peer_number AND u.direction = 'inbound' AND u.read = 0) AS unread
       FROM messages m
       JOIN (SELECT peer_number, MAX(created_at) AS mx FROM messages WHERE tenant_id = ? GROUP BY peer_number) latest
         ON m.peer_number = latest.peer_number AND m.created_at = latest.mx
       LEFT JOIN fb_contacts fb ON fb.tenant_id = ? AND m.peer_number = 'messenger:' || fb.psid
       WHERE m.tenant_id = ?
       GROUP BY m.peer_number
       ORDER BY m.created_at DESC`
    )
    .bind(scope.tenantId, scope.tenantId, scope.tenantId, scope.tenantId)
    .all<{ number: string; fb_name: string | null; last_body: string; last_ts: number; unread: number }>();
  return rows.results.map((r) => ({
    number: r.number,
    name: r.fb_name ?? null,
    last_body: r.last_body,
    last_ts: r.last_ts,
    unread: r.unread,
  }));
}

// `limit` returns only the LAST n messages (still in ascending order) — used by the call-detail
// SMS peek, which only shows a handful and shouldn't pull a whole long-running thread out of D1.
export async function listThread(scope: TenantScope, peer: string, limit?: number): Promise<MessageRow[]> {
  if (limit != null) {
    const rows = await scope.db
      .prepare(
        "SELECT * FROM (SELECT id, direction, body, created_at AS ts, status FROM messages WHERE tenant_id = ? AND peer_number = ? ORDER BY created_at DESC LIMIT ?) ORDER BY ts ASC"
      )
      .bind(scope.tenantId, peer, limit)
      .all<MessageRow>();
    return rows.results;
  }
  const rows = await scope.db
    .prepare(
      "SELECT id, direction, body, created_at AS ts, status FROM messages WHERE tenant_id = ? AND peer_number = ? ORDER BY created_at ASC"
    )
    .bind(scope.tenantId, peer)
    .all<MessageRow>();
  return rows.results;
}

export async function markThreadRead(scope: TenantScope, peer: string): Promise<void> {
  await scope.db
    .prepare("UPDATE messages SET read = 1 WHERE tenant_id = ? AND peer_number = ? AND direction = 'inbound'")
    .bind(scope.tenantId, peer)
    .run();
}
```

- [ ] **Step 4: Update src/api/messages.ts**

Add the import at the top:

```ts
import type { TenantScope } from "../db/scope";
```

Replace the three handler signatures and bodies:

```ts
export async function handleListConversations(scope: TenantScope): Promise<Response> {
  return jsonResponse(await listConversations(scope));
}

export async function handleGetThread(scope: TenantScope, peer: string, peek = false): Promise<Response> {
  // peek: read-only preview (call detail) — don't clear the unread badge just by looking, and only
  // return the recent tail (the panel shows 6; don't drag a whole long thread out of D1 for that).
  if (!peek) await markThreadRead(scope, peer);
  return jsonResponse(await listThread(scope, peer, peek ? 6 : undefined));
}
```

Change `handleSendMessage` to take a scope as its third parameter, and use it for the insert:

```ts
export async function handleSendMessage(request: Request, env: Env, scope: TenantScope): Promise<Response> {
```

and at line 73 replace `insertMessage(env.DB, {` with `insertMessage(scope, {`.

- [ ] **Step 5: Update the call sites in src/worker.ts**

Add the import:

```ts
import { scopeForAddress, scopeForStaff } from "./db/scope";
```

In the `/webhooks/twilio/sms` handler, resolve the tenant from the address the message arrived on before storing anything. Replace `await insertMessage(env.DB, {` and the block around it so the handler begins:

```ts
      if (params.From) {
        // Which business does this number belong to? Unknown or inactive -> acknowledge and drop.
        // A 500 here would make Twilio retry, turning one stray number into a retry storm.
        const scope = await scopeForAddress(env.DB, params.To ?? "");
        if (!scope) {
          console.warn(`inbound message for an address no tenant owns: ${params.To}`);
          return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
            headers: { "Content-Type": "text/xml" },
          });
        }
        await insertMessage(scope, {
```

Leave the rest of that handler's body unchanged for now — the Facebook name lookup still takes `env.DB` and is scoped in Part 2.

In the `/api/messages` routes, build a scope from the signed-in staff user:

```ts
      if (url.pathname === "/api/messages") {
        const scope = scopeForStaff(env.DB, staff);
        if (request.method === "GET") return handleListConversations(scope);
        if (request.method === "POST") return handleSendMessage(request, env, scope);
      }
      const messageThreadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageThreadMatch && request.method === "GET") {
        const peek = url.searchParams.get("peek") === "1";
        return handleGetThread(scopeForStaff(env.DB, staff), decodeURIComponent(messageThreadMatch[1]), peek);
      }
```

- [ ] **Step 6: Update the existing messages tests**

`test/db/messages.test.ts` calls the four functions with `env.DB`. Wrap each with a scope. At the top of the file add:

```ts
import { scopeForTenantId } from "../../src/db/scope";
```

and inside the describe block:

```ts
  const scope = scopeForTenantId(env.DB, "tnt_tcb");
```

Then replace every `env.DB` argument passed to `insertMessage`, `listConversations`, `listThread` and `markThreadRead` with `scope`. Do not change the assertions.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/db/messagesIsolation.test.ts test/db/messages.test.ts`
Expected: PASS — 5 isolation tests plus the existing message tests.

- [ ] **Step 8: Typecheck and run the full suite**

Run: `npx tsc --noEmit; echo $?`
Expected: `0`. Any error here is a call site not yet updated — fix it.

Run: `npx vitest run`
Expected: all files green. `test/worker.test.ts` exercises the SMS webhook; it will need `tenant_channels` to contain the `To` number it posts with. If a webhook test now fails, add the address it uses to the seed in that test rather than loosening `scopeForAddress`.

- [ ] **Step 9: Commit**

```bash
git add src/db/messages.ts src/api/messages.ts src/worker.ts test/db/messagesIsolation.test.ts test/db/messages.test.ts
git commit -m "feat(tenancy): scope the messages module and its call sites"
```

---

## What Part 1 deliberately leaves undone

- The other 12 modules in `src/db/` still take a bare `D1Database`. Part 2.
- `CallSession`, `transcribe.ts`, `facebook/backfill.ts` and the cron sweeps still run unscoped. Part 3.
- The CI guard is not written yet — it cannot pass until every module is migrated. Part 3.
- Nothing is deployed. Production rollout is the last task of Part 3.

**Part 1 is done when:** the migration is applied locally, `messages` is fully scoped with isolation proven against colliding fixtures, `requireStaffUser` carries a tenant, and the full suite is green.

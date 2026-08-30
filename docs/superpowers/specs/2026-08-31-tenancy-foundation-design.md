# Tenancy Foundation — design

**Status:** approved, ready for implementation planning
**Date:** 2026-08-31
**Sub-project:** 1 of 7 (see "Where this sits" below)

## Why

TCB Phone is a single-business staff tool. Every one of its 18 tables assumes one business, and
the Twilio credentials, phone numbers and Facebook Page all live in worker config. To sell it to
other businesses — the ServiceM8-native phone system for Australian trades — every row of data has
to belong to a tenant, and no tenant may ever see another's calls, messages or recordings.

This sub-project adds that foundation and nothing else. When it ships, the product behaves exactly
as it does today, with TCB as tenant 1. That invisibility is the point: it is the riskiest thing to
retrofit later, and the only safe time to do it is while there is exactly one tenant.

## Where this sits

| # | Sub-project | Depends on |
|---|-------------|-----------|
| **1** | **Tenancy foundation** (this spec) | — |
| 2 | Sign-up & onboarding | 1 |
| 3 | Twilio subaccount + number provisioning | 1, 2 |
| 4 | Billing (Stripe, per-seat, usage metering) | 1, 2, 3 |
| 5 | ServiceM8 integration — the product wedge | 1, 2 |
| 6 | Per-tenant Facebook Page connection | 1, 2 |
| 7 | App Store submission under the public story | 2–5 |

Sub-projects 1–4 must all land before a single outside customer can be served.

## Product decisions this assumes

Settled during brainstorming; recorded here so the implementation does not relitigate them.

- **Pricing:** per seat, generous included minutes. Stripe subscription with seat quantity.
- **Access:** anyone may register, but a human approves before a number is provisioned.
- **Fraud containment:** hard spend caps per tenant, international dialling off by default, one
  Twilio subaccount per tenant so the blast radius is contained.
- **Support:** business hours, stated up front.
- **One email belongs to one tenant.** A person cannot be a member of two businesses. Revisit only
  if a customer actually asks.

## Data model

A new `tenants` table:

```sql
CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,      -- 'tnt_tcb', 'tnt_<uuid>'
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,         -- 'active' | 'pending' | 'suspended'
  created_at INTEGER NOT NULL
);
```

Then `tenant_id TEXT NOT NULL` on the 15 tenant-scoped tables (every table except the three global
ones below), with composite indexes on `(tenant_id, …)` for the hot paths — messages by peer,
calls by date.

### The migration default is `''`, deliberately

SQLite cannot add a `NOT NULL` column without a default, so each table is migrated as:

```sql
ALTER TABLE messages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
UPDATE messages SET tenant_id = 'tnt_tcb';
```

The default is the empty string rather than TCB's id. If code ever inserts a row without a tenant,
it lands as `''`, which matches no tenant and is invisible to everyone. Defaulting to TCB would
silently file stray rows into the operator's own account, where nobody would notice. Fail-closed
beats fail-quiet. A test asserts that no row in any table has `tenant_id = ''`.

### Three tables stay global

`sessions`, `login_attempts`, `password_tokens`. (The new `tenants` table is global by nature.)

All three are consulted *before* the caller's identity is known — a login attempt cannot be scoped
by tenant when resolving which tenant the email belongs to is the whole point. `staff_users` gains
a `tenant_id` column but is still looked up by email globally at login.

## Tenant resolution

Three entry points, three constructors. There is no fourth way to obtain a scope.

1. **Authenticated app requests** (`/api/*`, `/admin/*`)
   `requireStaffUser` already resolves session → `staff_users`; it gains `tenantId` in its return
   type, so every authenticated request carries tenant identity from its first line.

2. **Twilio webhooks** (voice, SMS, status callbacks, Messenger)
   These arrive unauthenticated with `To` set to a business number, or to the Page's Messenger
   address. A dedicated `tenant_channels(address, tenant_id, kind)` table does the routing:
   `phone_numbers` holds only E.164 numbers and not the Messenger address, and routing wants a
   different lifecycle from the user-facing number-management table. Order of operations:

   ```
   look up tenant_channels by address  →  tenant
   fetch that tenant's Twilio credentials
   validate the Twilio signature
   act
   ```

   This number→tenant lookup is the single query that legitimately runs outside a tenant scope. It
   reads only the routing mapping — no customer data — and the signature check still gates every
   action that follows. Messenger inbound resolves the same way via the Page id.

3. **Cron** (`scheduled`)
   `reconcileStaleCalls`, `backfillTranscripts` and `backfillFacebookNames` currently run globally.
   They become: for each active tenant, run within that tenant's scope.

`CallSession` (the Durable Object) carries `tenantId` in its state, set when the call is created.
Note that it queries the shared D1 `calls` table directly via `env.DB` — it is **not** exempt from
scoping, and its queries move behind the same scoped helpers as everything else.

## Isolation

D1/SQLite has no row-level security. Nothing here can make cross-tenant reads *structurally*
impossible the way Postgres RLS can. The goal is instead: hard to get wrong, and impossible to get
wrong **silently**.

### The scope type

```ts
// src/db/scope.ts
export type TenantScope = { readonly db: D1Database; readonly tenantId: string };
```

Produced only by `scopeForStaff()`, `scopeForAddress()` and `scopeForTenantId()`, each of which
throws on an empty tenant id. Every `src/db/*` function takes a `TenantScope` in place of a bare
`D1Database`. The data layer becomes unreachable without first proving which tenant is being acted
for, and the compiler enforces it.

### The test harness

Two tenants seeded with **deliberately colliding data**, because collisions are where real leaks
hide. The motivating case: two businesses can both hold a conversation with the same phone number —
a shared supplier, or a wrong number. `peer_number` is not unique, so any lookup by peer that
forgets its tenant returns another business's conversation with that person.

For every data module, three assertions:

- **Reads** — tenant A's scope returns only A's rows.
- **Writes** — an update or delete issued under A's scope cannot touch B's row, *even when
  addressed by a colliding key*. `markThreadRead(scopeA, "+61400000000")` must leave B's unread
  count untouched.
- **Inserts** — always land with the correct `tenant_id`, never `''`.

### The CI guard

A script that fails the build on two conditions:

- any `.prepare(` outside the allowlisted data layer (`src/db/` and `src/access/` only);
- any SQL in `src/db/` touching a tenant-scoped table without mentioning `tenant_id`.

It is regex-based and will not catch a subtly wrong clause. It exists to catch the realistic
failure: a brand-new query written months from now that forgets tenancy altogether.

## Error handling

- **Webhook for a number belonging to no tenant** → log and return 204. Never 500: a 500 makes
  Twilio retry, turning one misconfigured number into a retry storm.
- **Webhook for a non-active tenant** (pending or suspended) → refuse to act. Three lines now; a
  security hole if bolted on after billing exists.
- **Empty tenant id reaching a scope constructor** → throw. Failing a request loudly is strictly
  better than serving one tenant's data to another.

## Explicitly out of scope

- **Per-tenant Twilio credentials.** They stay in `env` for now — with one tenant those are the
  same thing. What gets built here is the *resolution order*, so sub-project 3 only has to swap
  where credentials come from.
- Sign-up, onboarding, billing, provisioning, ServiceM8, per-tenant Facebook. All later.
- Multi-tenant membership for a single email.

## Rollout

1. Apply the migration (add columns, create the `tnt_tcb` row, backfill). CI applies migrations
   before deploying, which is the required order here.
2. Deploy the scoped code. Still one tenant; no behaviour change.
3. Verify production: inbound and outbound calls, SMS both directions, Messenger, the dashboard,
   the mobile app.

## Done means

- Migration applied to production D1.
- All 117 query sites scoped through `TenantScope`.
- The 520 existing tests pass unchanged in behaviour.
- New isolation tests pass — one per data module, 13 modules in `src/db/`.
- CI guard active and failing the build on a raw `env.DB` escape.
- Production behaves exactly as it does today, with TCB as tenant 1.

## Risks

- **Large, boring, high-consequence refactor with no visible payoff.** The temptation will be to
  rush it. A missed `WHERE` here is a data breach later.
- **Isolation bugs are invisible while there is one tenant.** TCB will be tenant 1 for months. The
  two-tenant harness is the only thing exercising isolation before a paying customer does.
- **Test churn.** Threading a scope argument through 520 tests is mechanical but voluminous, and
  mechanical edits at volume are where mistakes hide.

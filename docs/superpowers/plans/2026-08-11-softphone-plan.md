# Softphone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the phone-number-based ring/outbound calling system with a Twilio Voice-SDK softphone: Conference-based calls (mute/hold/transfer), per-staff presence gated by a working-hours schedule, a `/phone` dashboard page, a call blocklist, and a real installable desktop app.

**Architecture:** The existing Enqueue/Gather hold-queue and cascade/simultaneous ring-plan machinery in `CallSession.ts` stays almost entirely intact — only the dial target type (phone number → Twilio Client identity) and the final bridge step (direct `<Dial><Queue>` → REST-redirect the caller into a real `<Dial><Conference>`) change. Everything else (Access Tokens, presence, hold/transfer, the softphone UI, the desktop app) is new, additive surface area.

**Tech Stack:** Twilio Voice JS SDK (CDN `<script>`), Twilio REST API (Conference Participants + Call redirect), `jose` (already a dependency, used for Access Token JWT signing), D1, Durable Objects, Vitest + `@cloudflare/vitest-pool-workers`, Electron.

## Global Constraints

- No personal phone numbers anywhere in the ring or outbound paths — every dial target is a Twilio Client identity (`client:{staff email}`) or, for outbound, the customer's own number.
- The caller stays in the existing per-call Twilio Queue (unchanged `<Enqueue>`/`<Gather>` hold logic, including star-press-for-callback) for the entire ring/hold phase. A real Twilio Conference is only created at the moment an agent answers.
- A staff member resolves to **available** for ring targeting only if: `status === 'available'` AND the current time falls within their `schedule` AND their `lastHeartbeatAt` is within `HEARTBEAT_STALE_MS` (60000ms) of now.
- Zero frontend build tooling — the Voice SDK loads via a CDN `<script>` tag, matching the Drawflow IVR canvas editor's existing convention.
- D1 migrations are numbered sequentially; the next one is `0008`.
- Mutating API routes that change shared configuration (business hours, blocklist, staff schedules, IVR flow) require `staff.role === 'admin'` via the existing `forbiddenUnlessAdmin` pattern (`src/api/settings.ts`). Routes a staff member acts on for themselves (presence toggle, heartbeat, hold/transfer on a call they're on) do not require admin.
- Every backend/logic task follows this repo's existing TDD convention: write the failing test first using the same mocked-`fetch`/mocked-webhook-payload patterns already used in `test/twilio/restClient.test.ts` and `test/durable-objects/CallSession.test.ts`.
- Run `npm run typecheck` and `npm test` before every commit.

---

## File Structure

**New files:**
- `migrations/0008_softphone.sql` — presence columns on `staff_users`.
- `migrations/0009_drop_mobile_number.sql` — drops the now-unused `mobile_number` column.
- `src/db/staff.ts` — staff roster/status/schedule/heartbeat CRUD.
- `src/dial/presence.ts` — pure `isStaffAvailable` resolution logic.
- `src/twilio/conferenceClient.ts` — Conference Participants REST calls (find/hold/remove).
- `src/twilio/conferenceTwiml.ts` — `<Dial><Conference>` TwiML renderers.
- `src/twilio/accessToken.ts` — Twilio Access Token minting.
- `src/api/softphone.ts` — token, presence, heartbeat, hold, transfer endpoints.
- `src/api/staff.ts` — staff roster (GET) + per-staff schedule (PUT, admin).
- `src/html/pages/phone.ts` — the softphone dashboard page.

**Modified files:**
- `src/db/settings.ts` — remove `StaffRingEntry`/`getStaffRingList`/`setStaffRingList`; add `getCallBlocklist`/`setCallBlocklist`.
- `src/api/settings.ts` — remove ring-list handlers; add blocklist handlers.
- `src/dial/ringQueue.ts` — `resolveRingTargets` becomes async, presence-based, returns Client identities.
- `src/api/ivrFlow.ts` — `ring` node config validator: `target` becomes `"all" | string[]`.
- `src/html/pages/ivrFlow.ts` — ring node's target field becomes a staff multi-select.
- `src/twilio/restClient.ts` — add `redirectCall`.
- `src/durable-objects/CallSession.ts` — `handleAgentAnswer` bridges into a Conference instead of a Queue; new `join_conference`-adjacent webhook route (rendered directly in `worker.ts`, no DO involvement needed).
- `src/access/requireStaffUser.ts` — drop `mobile_number` from `StaffUser`.
- `src/worker.ts` — remove click-to-call/outbound-call routes; add all new softphone/staff/blocklist/TwiML-app routes; blocklist check in `/webhooks/twilio`.
- `src/html/pages/callHistory.ts` — remove the old ring-my-phone dialer form.
- `src/html/pages/settings.ts` — remove ring-list UI; add blocklist + staff schedule UI.
- `src/html/layout.ts` — add a "Phone" nav item.
- `desktop/main.js` — mic permission, tray icon, notifications, load `/phone`.

**Removed files:**
- `src/api/outboundCalls.ts`.

---

## Task 1: Migration 0008 + staff presence data layer

**Files:**
- Create: `migrations/0008_softphone.sql`
- Create: `src/dial/presence.ts`
- Create: `src/db/staff.ts`
- Test: `test/dial/presence.test.ts`
- Test: `test/db/staff.test.ts`

**Interfaces:**
- Produces: `StaffStatus`, `StaffPresenceRow`, `getStaffRoster(db)`, `getStaffByEmail(db, email)`, `setStaffStatus(db, email, status, awayReason)`, `setStaffSchedule(db, email, schedule)`, `touchHeartbeat(db, email)` (all in `src/db/staff.ts`); `HEARTBEAT_STALE_MS`, `isStaffAvailable(staff, now)` (in `src/dial/presence.ts`).
- Consumes: `BusinessHoursSchedule`/`isWithinBusinessHours` from `src/ivr/businessHours.ts` (existing).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0008_softphone.sql
ALTER TABLE staff_users ADD COLUMN status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('available','away','offline'));
ALTER TABLE staff_users ADD COLUMN away_reason TEXT;
ALTER TABLE staff_users ADD COLUMN schedule TEXT NOT NULL DEFAULT '{"mon":{"open":"07:00","close":"17:00"},"tue":{"open":"07:00","close":"17:00"},"wed":{"open":"07:00","close":"17:00"},"thu":{"open":"07:00","close":"17:00"},"fri":{"open":"07:00","close":"17:00"},"sat":null,"sun":null}';
ALTER TABLE staff_users ADD COLUMN last_heartbeat_at INTEGER;
```

Apply locally per this project's existing convention (check `README.md`/prior task reports for the exact `wrangler d1 migrations apply` invocation used for migrations 0004-0007; use the same one, local only — remote application is deferred to Task 12).

- [ ] **Step 2: Write the failing test for `isStaffAvailable`**

```typescript
// test/dial/presence.test.ts
import { describe, it, expect } from "vitest";
import { isStaffAvailable, HEARTBEAT_STALE_MS, type StaffPresenceRow } from "../../src/dial/presence";

const MON_10AM = new Date("2026-08-10T00:00:00.000Z"); // Mon 10:00 Australia/Sydney (UTC+10 in Aug)
const SCHEDULE_9_TO_5 = {
  mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" }, thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" }, sat: null, sun: null,
};

function staff(overrides: Partial<StaffPresenceRow>): StaffPresenceRow {
  return {
    email: "a@b.com", role: "staff", status: "available", awayReason: null,
    schedule: SCHEDULE_9_TO_5, lastHeartbeatAt: MON_10AM.getTime(), ...overrides,
  };
}

describe("isStaffAvailable", () => {
  it("is available when status is available, within schedule, and heartbeat is fresh", () => {
    expect(isStaffAvailable(staff({}), MON_10AM)).toBe(true);
  });

  it("is unavailable when status is away", () => {
    expect(isStaffAvailable(staff({ status: "away", awayReason: "lunch" }), MON_10AM)).toBe(false);
  });

  it("is unavailable when status is offline", () => {
    expect(isStaffAvailable(staff({ status: "offline" }), MON_10AM)).toBe(false);
  });

  it("is unavailable outside scheduled hours even if status is available", () => {
    const mon7am = new Date(MON_10AM.getTime() - 3 * 60 * 60 * 1000);
    expect(isStaffAvailable(staff({}), mon7am)).toBe(false);
  });

  it("is unavailable when the heartbeat is stale", () => {
    const stale = staff({ lastHeartbeatAt: MON_10AM.getTime() - HEARTBEAT_STALE_MS - 1 });
    expect(isStaffAvailable(stale, MON_10AM)).toBe(false);
  });

  it("is unavailable when there has never been a heartbeat", () => {
    expect(isStaffAvailable(staff({ lastHeartbeatAt: null }), MON_10AM)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/dial/presence.test.ts`
Expected: FAIL — `src/dial/presence.ts` does not exist yet.

- [ ] **Step 4: Implement `src/dial/presence.ts`**

```typescript
import type { BusinessHoursSchedule } from "../ivr/businessHours";
import { isWithinBusinessHours } from "../ivr/businessHours";

export type StaffStatus = "available" | "away" | "offline";

export type StaffPresenceRow = {
  email: string;
  role: "admin" | "staff";
  status: StaffStatus;
  awayReason: string | null;
  schedule: BusinessHoursSchedule;
  lastHeartbeatAt: number | null;
};

export const HEARTBEAT_STALE_MS = 60_000;

export function isStaffAvailable(staff: StaffPresenceRow, now: Date): boolean {
  if (staff.status !== "available") return false;
  if (staff.lastHeartbeatAt === null) return false;
  if (now.getTime() - staff.lastHeartbeatAt > HEARTBEAT_STALE_MS) return false;
  return isWithinBusinessHours(staff.schedule, now);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/dial/presence.test.ts`
Expected: PASS (6/6)

- [ ] **Step 6: Write the failing test for the staff data layer**

```typescript
// test/db/staff.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getStaffRoster, getStaffByEmail, setStaffStatus, setStaffSchedule, touchHeartbeat } from "../../src/db/staff";

describe("staff presence data layer", () => {
  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM staff_users`);
    await env.DB.prepare(
      "INSERT INTO staff_users (email, role, created_at, status, schedule) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("a@b.com", "staff", Date.now(), "offline", JSON.stringify({
        mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
      }))
      .run();
  });

  it("getStaffRoster returns parsed rows", async () => {
    const roster = await getStaffRoster(env.DB);
    expect(roster).toHaveLength(1);
    expect(roster[0].email).toBe("a@b.com");
    expect(roster[0].schedule.mon).toEqual({ open: "09:00", close: "17:00" });
  });

  it("getStaffByEmail returns null for an unknown email", async () => {
    expect(await getStaffByEmail(env.DB, "nobody@b.com")).toBeNull();
  });

  it("setStaffStatus updates status and awayReason", async () => {
    await setStaffStatus(env.DB, "a@b.com", "away", "out to lunch");
    const row = await getStaffByEmail(env.DB, "a@b.com");
    expect(row?.status).toBe("away");
    expect(row?.awayReason).toBe("out to lunch");
  });

  it("setStaffSchedule overwrites the schedule JSON", async () => {
    const newSchedule = {
      mon: { open: "08:00", close: "16:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
    };
    await setStaffSchedule(env.DB, "a@b.com", newSchedule);
    const row = await getStaffByEmail(env.DB, "a@b.com");
    expect(row?.schedule).toEqual(newSchedule);
  });

  it("touchHeartbeat sets lastHeartbeatAt to roughly now", async () => {
    const before = Date.now();
    await touchHeartbeat(env.DB, "a@b.com");
    const row = await getStaffByEmail(env.DB, "a@b.com");
    expect(row?.lastHeartbeatAt).toBeGreaterThanOrEqual(before);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/db/staff.test.ts`
Expected: FAIL — `src/db/staff.ts` does not exist yet.

- [ ] **Step 8: Implement `src/db/staff.ts`**

```typescript
import type { BusinessHoursSchedule } from "../ivr/businessHours";
import type { StaffPresenceRow, StaffStatus } from "../dial/presence";

type StaffRow = {
  email: string;
  role: "admin" | "staff";
  status: StaffStatus;
  away_reason: string | null;
  schedule: string;
  last_heartbeat_at: number | null;
};

function toPresenceRow(row: StaffRow): StaffPresenceRow {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    awayReason: row.away_reason,
    schedule: JSON.parse(row.schedule) as BusinessHoursSchedule,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

export async function getStaffRoster(db: D1Database): Promise<StaffPresenceRow[]> {
  const result = await db.prepare("SELECT * FROM staff_users").all<StaffRow>();
  return result.results.map(toPresenceRow);
}

export async function getStaffByEmail(db: D1Database, email: string): Promise<StaffPresenceRow | null> {
  const row = await db.prepare("SELECT * FROM staff_users WHERE email = ?").bind(email).first<StaffRow>();
  return row ? toPresenceRow(row) : null;
}

export async function setStaffStatus(
  db: D1Database,
  email: string,
  status: StaffStatus,
  awayReason: string | null
): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET status = ?, away_reason = ? WHERE email = ?")
    .bind(status, awayReason, email)
    .run();
}

export async function setStaffSchedule(db: D1Database, email: string, schedule: BusinessHoursSchedule): Promise<void> {
  await db
    .prepare("UPDATE staff_users SET schedule = ? WHERE email = ?")
    .bind(JSON.stringify(schedule), email)
    .run();
}

export async function touchHeartbeat(db: D1Database, email: string): Promise<void> {
  await db.prepare("UPDATE staff_users SET last_heartbeat_at = ? WHERE email = ?").bind(Date.now(), email).run();
}
```

Re-export `StaffPresenceRow`/`StaffStatus` from `src/dial/presence.ts` (already defined there in Step 4) — `src/db/staff.ts` imports the types rather than redefining them, since presence resolution and data access share one shape.

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/db/staff.test.ts`
Expected: PASS (5/5)

- [ ] **Step 10: Run the full suite and typecheck, then commit**

Run: `npm test && npm run typecheck`
Expected: all passing, no type errors (this task only adds files — nothing existing changes).

```bash
git add migrations/0008_softphone.sql src/dial/presence.ts src/db/staff.ts test/dial/presence.test.ts test/db/staff.test.ts
git commit -m "Add staff presence data layer and availability resolution"
```

---

## Task 2: Remove the old click-to-call system, add the call blocklist

**Files:**
- Delete: `src/api/outboundCalls.ts`
- Delete: `test/api/outboundCalls.test.ts` (if present)
- Create: `migrations/0009_drop_mobile_number.sql`
- Modify: `src/access/requireStaffUser.ts` — drop `mobile_number` from `StaffUser` and its SELECT
- Modify: `src/db/settings.ts` — add `getCallBlocklist`/`setCallBlocklist`
- Modify: `src/api/settings.ts` — add blocklist handlers
- Modify: `src/worker.ts` — remove outbound-call/click-to-call routes; add blocklist check + blocklist API routes
- Modify: `src/html/pages/callHistory.ts` — remove the dialer form
- Modify: `src/html/pages/settings.ts` — add blocklist UI section
- Test: `test/db/settings.test.ts`, `test/api/settings.test.ts`, `test/worker.test.ts` (update existing files)

**Interfaces:**
- Produces: `getCallBlocklist(db): Promise<string[]>`, `setCallBlocklist(db, numbers: string[]): Promise<void>` (`src/db/settings.ts`); `handleGetCallBlocklist(db)`, `handlePutCallBlocklist(request, db, staff)` (`src/api/settings.ts`).
- Consumes: `forbiddenUnlessAdmin` (existing, `src/api/settings.ts`).

- [ ] **Step 1: Delete the obsolete outbound-call code**

```bash
git rm src/api/outboundCalls.ts
git rm test/api/outboundCalls.test.ts 2>/dev/null || true
```

- [ ] **Step 2: Drop `mobile_number`**

```sql
-- migrations/0009_drop_mobile_number.sql
ALTER TABLE staff_users DROP COLUMN mobile_number;
```

In `src/access/requireStaffUser.ts`, change:
```typescript
export type StaffUser = { email: string; role: "admin" | "staff"; mobile_number: string | null };
```
to:
```typescript
export type StaffUser = { email: string; role: "admin" | "staff" };
```
and change the SELECT:
```typescript
const row = await env.DB.prepare("SELECT email, role, mobile_number FROM staff_users WHERE email = ?")
```
to:
```typescript
const row = await env.DB.prepare("SELECT email, role FROM staff_users WHERE email = ?")
```
and the return:
```typescript
return { email: row.email, role: row.role, mobile_number: row.mobile_number };
```
to:
```typescript
return { email: row.email, role: row.role };
```
and drop `mobile_number` from the row's inline type `{ email: string; role: "admin" | "staff"; mobile_number: string | null }` in the same file.

- [ ] **Step 3: Remove the routes and handler that used `mobile_number`/click-to-call in `src/worker.ts`**

Remove the import `import { handleCreateOutboundCall } from "./api/outboundCalls";`.

Remove the `/api/calls/outbound` route block (the one guarded by the "Must be checked BEFORE the /api/calls/:id regex" comment) and its `handleCreateOutboundCall` call.

Remove the `/webhooks/twilio/click-to-call` route block and the `/webhooks/twilio/recording-status-outbound` route block in their entirety (both are click-to-call-only; outbound dialing is rebuilt in Task 8 on a different route, `/twiml/voice-app`, with its own recording handling).

- [ ] **Step 4: Write the failing test for the blocklist data layer**

Append to `test/db/settings.test.ts` (create it if it doesn't already exist, following the file's existing `describe` structure for `getBusinessHours`/`setBusinessHours`):

```typescript
describe("call blocklist", () => {
  it("returns an empty array when nothing is set", async () => {
    expect(await getCallBlocklist(env.DB)).toEqual([]);
  });

  it("round-trips a saved list", async () => {
    await setCallBlocklist(env.DB, ["+61400000000", "+61400000001"]);
    expect(await getCallBlocklist(env.DB)).toEqual(["+61400000000", "+61400000001"]);
  });
});
```//add the matching import: `import { getCallBlocklist, setCallBlocklist } from "../../src/db/settings";`

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run test/db/settings.test.ts -t "call blocklist"`
Expected: FAIL — `getCallBlocklist` is not exported yet.

- [ ] **Step 6: Implement the blocklist data layer**

In `src/db/settings.ts`, remove `StaffRingEntry`, `getStaffRingList`, `setStaffRingList`, and the `STAFF_RING_LIST_KEY` constant entirely. Add:

```typescript
const CALL_BLOCKLIST_KEY = "call_blocklist";

export async function getCallBlocklist(db: D1Database): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(CALL_BLOCKLIST_KEY).first<{ value: string }>();
  if (!row) return [];
  return JSON.parse(row.value) as string[];
}

export async function setCallBlocklist(db: D1Database, numbers: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(CALL_BLOCKLIST_KEY, JSON.stringify(numbers))
    .run();
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/db/settings.test.ts`
Expected: PASS (all cases, including the two new ones).

- [ ] **Step 8: Write the failing test for the blocklist API handlers**

Add to `test/api/settings.test.ts` (following its existing pattern for `handlePutBusinessHours`, including the admin-forbidden case):

```typescript
describe("handlePutCallBlocklist", () => {
  it("rejects non-admins", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000"]) }),
      env.DB,
      { email: "staff@b.com", role: "staff" }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a non-array body", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ not: "an array" }) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(400);
  });

  it("rejects an array containing a non-string", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000", 5]) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(400);
  });

  it("saves a valid list for an admin", async () => {
    const res = await handlePutCallBlocklist(
      new Request("http://x", { method: "PUT", body: JSON.stringify(["+61400000000"]) }),
      env.DB,
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(200);
    expect(await getCallBlocklist(env.DB)).toEqual(["+61400000000"]);
  });
});
```

Remove the corresponding `handleGetStaffRingList`/`handlePutStaffRingList` test blocks (the functions no longer exist).

- [ ] **Step 9: Run test to verify it fails, then implement**

Run: `npx vitest run test/api/settings.test.ts -t "handlePutCallBlocklist"` → FAIL.

In `src/api/settings.ts`, remove `isStaffRingList`, `handleGetStaffRingList`, `handlePutStaffRingList`, and the `StaffRingEntry` import. Add:

```typescript
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export async function handleGetCallBlocklist(db: D1Database): Promise<Response> {
  return jsonResponse(await getCallBlocklist(db));
}

export async function handlePutCallBlocklist(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }
  if (!isStringArray(body)) return INVALID_BODY_RESPONSE();
  await setCallBlocklist(db, body);
  return jsonResponse({ ok: true });
}
```
and update the `src/db/settings` import line to pull in `getCallBlocklist, setCallBlocklist` instead of the ring-list functions.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/api/settings.test.ts`
Expected: PASS.

- [ ] **Step 11: Wire the blocklist into `src/worker.ts` — API routes and the inbound-call check**

Replace the ring-list route block (the one calling `handleGetStaffRingList`/`handlePutStaffRingList`) with:

```typescript
if (url.pathname === "/api/settings/call-blocklist") {
  if (request.method === "GET") return handleGetCallBlocklist(env.DB);
  if (request.method === "PUT") return handlePutCallBlocklist(request, env.DB, staff);
}
```

Update the `./api/settings` import to bring in `handleGetCallBlocklist, handlePutCallBlocklist` instead of the ring-list handlers.

In the `/webhooks/twilio` handler, immediately after the existing signature-verification block (`if (!valid) { return new Response("invalid signature", { status: 401 }); }`) and before the `CALL_SESSION` stub lookup, add:

```typescript
const blocklist = await getCallBlocklist(env.DB);
if (blocklist.includes(params.From)) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>', {
    headers: { "Content-Type": "text/xml" },
  });
}
```

Add `getCallBlocklist` to the existing `./db/settings` import in `worker.ts`.

- [ ] **Step 12: Write the failing test for the blocklist reject behavior**

Add to `test/worker.test.ts`, following its existing pattern for posting to `/webhooks/twilio` with a mocked valid signature:

```typescript
it("rejects a call from a blocklisted number before it reaches the CallSession DO", async () => {
  await setCallBlocklist(env.DB, ["+61400000099"]);
  const res = await postSignedTwilioWebhook("/webhooks/twilio", { CallSid: "CA_blocked", From: "+61400000099", To: "+61899999999" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<Reject/>");
  const call = await env.DB.prepare("SELECT 1 FROM calls WHERE id = ?").bind("CA_blocked").first();
  expect(call).toBeNull();
});
```

(Use whatever helper this test file already has for posting a validly-signed Twilio webhook — follow the exact pattern used by the file's other `/webhooks/twilio` tests rather than reintroducing signature logic.)

- [ ] **Step 13: Run test to verify it fails, then confirm it passes after Step 11's implementation**

Run: `npx vitest run test/worker.test.ts -t "blocklisted"`
Expected: FAIL before Step 11 is in place, PASS after (Step 11 was already implemented above — this step is verifying the wiring, not writing new code).

- [ ] **Step 14: Remove the dialer form from the call history page**

In `src/html/pages/callHistory.ts`, remove the `<form class="settings-form" id="dialer-form">...</form>` block and the `document.getElementById('dialer-form').addEventListener(...)` script block. The outbound dialer moves to the new `/phone` page in Task 9.

- [ ] **Step 15: Add a blocklist UI section to the settings page**

In `src/html/pages/settings.ts`, add a new form section (following the exact same `settings-form` + status-span pattern as the existing business-hours form) that lists blocked numbers one per line in a `<textarea>`, with a save button that PUTs the split/trimmed/non-empty lines to `/api/settings/call-blocklist`. Add the `blocklist: string[]` parameter to `renderSettingsPage`'s signature and thread it through from the two call sites in `worker.ts` (fetch it via `getCallBlocklist(env.DB)` alongside the existing `getBusinessHours`/schedule fetches feeding that page). Remove the now-defunct `ringList`/ring-list-related markup and script blocks from this file entirely (the ring list itself was already deleted from the data layer in Step 6).

- [ ] **Step 16: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "Remove phone-number click-to-call system, add call blocklist"
```

---

## Task 3: Ring targeting rewrite — presence-based Client identities

**Files:**
- Modify: `src/dial/ringQueue.ts`
- Modify: `src/durable-objects/CallSession.ts` (the `startRing` call site only)
- Modify: `src/api/ivrFlow.ts` (`isRingConfig`, `RingConfig`-adjacent type)
- Modify: `src/html/pages/ivrFlow.ts` (ring node's target field)
- Test: `test/dial/ringQueue.test.ts`, `test/durable-objects/CallSession.test.ts`, `test/api/ivrFlow.test.ts`

**Interfaces:**
- Produces: `resolveRingTargets(db, target: "all" | string[], now: Date): Promise<string[]>` returning `client:{email}` strings.
- Consumes: `getStaffRoster` (Task 1, `src/db/staff.ts`), `isStaffAvailable` (Task 1, `src/dial/presence.ts`).

- [ ] **Step 1: Write the failing test for the rewritten `resolveRingTargets`**

```typescript
// test/dial/ringQueue.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveRingTargets } from "../../src/dial/ringQueue";

const NOW = new Date("2026-08-10T00:00:00.000Z"); // Mon 10:00 Australia/Sydney
const OPEN_SCHEDULE = JSON.stringify({
  mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
});

async function insertStaff(email: string, status: string, heartbeatAt: number | null) {
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at) VALUES (?, 'staff', ?, ?, ?, ?)"
  )
    .bind(email, Date.now(), status, OPEN_SCHEDULE, heartbeatAt)
    .run();
}

describe("resolveRingTargets", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
  });

  it("'all' resolves to every currently-available staff member, as client identities", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime());
    await insertStaff("c@b.com", "offline", NOW.getTime());
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual(["client:a@b.com"]);
  });

  it("a specific staff list only considers those staff, filtered by availability", async () => {
    await insertStaff("a@b.com", "available", NOW.getTime());
    await insertStaff("b@b.com", "available", NOW.getTime());
    expect(await resolveRingTargets(env.DB, ["a@b.com"], NOW)).toEqual(["client:a@b.com"]);
  });

  it("returns an empty array when nobody targeted is available", async () => {
    await insertStaff("a@b.com", "away", NOW.getTime());
    expect(await resolveRingTargets(env.DB, "all", NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dial/ringQueue.test.ts`
Expected: FAIL — current `resolveRingTargets` has a different (sync, phone-number) signature.

- [ ] **Step 3: Rewrite `src/dial/ringQueue.ts`**

```typescript
import { getStaffRoster } from "../db/staff";
import { isStaffAvailable } from "./presence";

export type RingNodeTarget = "all" | string[];

export async function resolveRingTargets(db: D1Database, target: RingNodeTarget, now: Date): Promise<string[]> {
  const roster = await getStaffRoster(db);
  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  return candidates.filter((s) => isStaffAvailable(s, now)).map((s) => `client:${s.email}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dial/ringQueue.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Update the `CallSession.ts` call site**

In `src/durable-objects/CallSession.ts`, remove the `import { getStaffRingList } from "../db/settings";` (keep `getBusinessHours` from the same import). Change:
```typescript
const numbers = resolveRingTargets(ringConfig.target, await getStaffRingList(this.env.DB));
```
to:
```typescript
const numbers = await resolveRingTargets(this.env.DB, ringConfig.target, new Date());
```
Update `RingConfig`'s `target: RingNodeTarget` — the imported `RingNodeTarget` type now means `"all" | string[]` automatically since it's the same imported type, no further change needed there.

- [ ] **Step 6: Update `CallSession.test.ts`'s existing ring-target mocking**

Wherever the existing test file seeds ring targets for a `ring` node (search for `getStaffRingList` or `isOnCall` in the test file), replace with directly inserting `staff_users` rows with `status = 'available'`, a schedule that covers the test's `now`, and a fresh `last_heartbeat_at`, matching the pattern established in Step 1 above. Update any assertion that expected a dialed phone number (e.g. `"+61400000000"`) to expect a `client:{email}` string instead.

- [ ] **Step 7: Run the full CallSession test file**

Run: `npx vitest run test/durable-objects/CallSession.test.ts`
Expected: PASS — confirms the ring-plan/cascade/simultaneous/star-press machinery is unaffected by the target-type change.

- [ ] **Step 8: Update the `ring` node config validator**

In `src/api/ivrFlow.ts`, add near the top:
```typescript
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
```
Change `isRingConfig`:
```typescript
function isRingConfig(c: Record<string, unknown>): boolean {
  return (
    (c.target === "all" || isStringArray(c.target)) &&
    (c.strategy === "cascade" || c.strategy === "simultaneous") &&
    typeof c.timeoutSeconds === "number" &&
    isNonEmptyString(c.noAnswerNextNodeId)
  );
}
```

- [ ] **Step 9: Write the failing test, then confirm the validator change**

Add to `test/api/ivrFlow.test.ts` (alongside the existing ring-node validation cases): a case PUTting a ring node with `target: ["a@b.com"]` expects `200`, and a case with `target: [123]` (non-string entry) expects `400`.

Run: `npx vitest run test/api/ivrFlow.test.ts`
Expected: PASS after Step 8 (the new cases would FAIL against the old validator, confirming the test is meaningful, then PASS with Step 8's change in place).

- [ ] **Step 10: Update the ring node's target field in the flow editor UI**

In `src/html/pages/ivrFlow.ts`, find the ring-node section of `buildFieldsHtml` (the form fields rendered in the slide-over edit panel) and `collectNodeFromPanel` (which reads them back out). Replace the existing `target` all/on_call_only `<select>` with a multi-select: an "All available staff" checkbox plus a checkbox list of staff emails (fetched via the new `GET /api/staff` endpoint from Task 6 — until Task 6 ships, render the checkbox list from a `staffEmails: string[]` parameter threaded into `renderIvrFlowPage`/its data-loading call site in `worker.ts`, sourced from `getStaffRoster(env.DB).then(r => r.map(s => s.email))`). When "All available staff" is checked, save `target: "all"`; otherwise save `target: [...checked emails]`.

- [ ] **Step 11: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "Rewrite ring targeting: presence-based Client identities, remove staff_ring_list"
```

---

## Task 4: Conference bridging — redirect the caller, bridge both legs into a Conference

**Files:**
- Modify: `src/twilio/restClient.ts` — add `redirectCall`
- Create: `src/twilio/conferenceClient.ts`
- Create: `src/twilio/conferenceTwiml.ts`
- Modify: `src/durable-objects/CallSession.ts` — `handleAgentAnswer`
- Modify: `src/worker.ts` — new `/webhooks/twilio/join-conference` route
- Test: `test/twilio/restClient.test.ts`, `test/twilio/conferenceClient.test.ts`, `test/twilio/conferenceTwiml.test.ts`, `test/durable-objects/CallSession.test.ts`, `test/worker.test.ts`

**Interfaces:**
- Produces: `redirectCall(accountSid, authToken, callSid, url): Promise<void>` (`restClient.ts`); `findConferenceSid(accountSid, authToken, friendlyName): Promise<string | null>`, `setParticipantHold(accountSid, authToken, conferenceSid, callSid, hold: boolean): Promise<void>`, `removeParticipant(accountSid, authToken, conferenceSid, callSid): Promise<void>` (`conferenceClient.ts`); `renderJoinConference(opts: {conferenceName: string}): string`, `renderDialAgentIntoConference(opts: {conferenceName: string; actionUrl: string; recordingStatusCallbackUrl: string}): string` (`conferenceTwiml.ts`).

- [ ] **Step 1: Write the failing test for `redirectCall`**

Add to `test/twilio/restClient.test.ts` (following the exact mocked-`fetch` pattern the file already uses for `createOutboundCall`/`cancelCall`):

```typescript
describe("redirectCall", () => {
  it("POSTs a Url update to the call resource with Basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await redirectCall("ACxxx", "authtoken", "CAcaller", "https://example.com/webhooks/twilio/join-conference?conf=CAcaller");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls/CAcaller.json",
      expect.objectContaining({ method: "POST" })
    );
    const call = fetchMock.mock.calls[0];
    const body = call[1].body as URLSearchParams;
    expect(body.get("Url")).toBe("https://example.com/webhooks/twilio/join-conference?conf=CAcaller");
    expect(call[1].headers.Authorization).toBe(`Basic ${btoa("ACxxx:authtoken")}`);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(redirectCall("ACxxx", "authtoken", "CAcaller", "https://example.com/x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then implement**

Run: `npx vitest run test/twilio/restClient.test.ts -t "redirectCall"` → FAIL.

Add to `src/twilio/restClient.ts`:
```typescript
export async function redirectCall(accountSid: string, authToken: string, callSid: string, url: string): Promise<void> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Url: url }),
  });
  if (!res.ok) throw new Error(`Twilio redirect-call failed: ${res.status}`);
}
```

Run: `npx vitest run test/twilio/restClient.test.ts` → PASS.

- [ ] **Step 3: Write the failing test for `conferenceClient.ts`**

```typescript
// test/twilio/conferenceClient.test.ts
import { describe, it, expect, vi } from "vitest";
import { findConferenceSid, setParticipantHold, removeParticipant } from "../../src/twilio/conferenceClient";

describe("findConferenceSid", () => {
  it("returns the first conference's Sid for a matching friendly name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ conferences: [{ sid: "CFxxx" }] }), { status: 200 }))
    );
    expect(await findConferenceSid("ACxxx", "authtoken", "CAcaller")).toBe("CFxxx");
  });

  it("returns null when no conference matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ conferences: [] }), { status: 200 })));
    expect(await findConferenceSid("ACxxx", "authtoken", "CAcaller")).toBeNull();
  });
});

describe("setParticipantHold", () => {
  it("POSTs Hold=true to the participant resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await setParticipantHold("ACxxx", "authtoken", "CFxxx", "CAcaller", true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Conferences/CFxxx/Participants/CAcaller.json",
      expect.objectContaining({ method: "POST" })
    );
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("Hold")).toBe("true");
  });
});

describe("removeParticipant", () => {
  it("DELETEs the participant resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await removeParticipant("ACxxx", "authtoken", "CFxxx", "CAagent");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Conferences/CFxxx/Participants/CAagent.json",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
```

- [ ] **Step 4: Run test to verify it fails, then implement `src/twilio/conferenceClient.ts`**

```typescript
function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${btoa(`${accountSid}:${authToken}`)}`;
}

export async function findConferenceSid(accountSid: string, authToken: string, friendlyName: string): Promise<string | null> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences.json?FriendlyName=${encodeURIComponent(friendlyName)}`,
    { headers: { Authorization: authHeader(accountSid, authToken) } }
  );
  if (!res.ok) throw new Error(`Twilio list-conferences failed: ${res.status}`);
  const json = await res.json<{ conferences: { sid: string }[] }>();
  return json.conferences[0]?.sid ?? null;
}

export async function setParticipantHold(
  accountSid: string,
  authToken: string,
  conferenceSid: string,
  callSid: string,
  hold: boolean
): Promise<void> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(accountSid, authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Hold: String(hold) }),
    }
  );
  if (!res.ok) throw new Error(`Twilio set-participant-hold failed: ${res.status}`);
}

export async function removeParticipant(
  accountSid: string,
  authToken: string,
  conferenceSid: string,
  callSid: string
): Promise<void> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
    { method: "DELETE", headers: { Authorization: authHeader(accountSid, authToken) } }
  );
  if (!res.ok && res.status !== 204) throw new Error(`Twilio remove-participant failed: ${res.status}`);
}
```

Run: `npx vitest run test/twilio/conferenceClient.test.ts` → PASS.

- [ ] **Step 5: Write the failing test for `conferenceTwiml.ts`**

```typescript
// test/twilio/conferenceTwiml.test.ts
import { describe, it, expect } from "vitest";
import { renderJoinConference, renderDialAgentIntoConference } from "../../src/twilio/conferenceTwiml";

describe("renderJoinConference", () => {
  it("renders a Dial/Conference document for the given name", () => {
    const xml = renderJoinConference({ conferenceName: "CAcaller" });
    expect(xml).toContain("<Dial><Conference>CAcaller</Conference></Dial>");
  });
});

describe("renderDialAgentIntoConference", () => {
  it("renders a Dial/Conference document with action + recording attributes", () => {
    const xml = renderDialAgentIntoConference({
      conferenceName: "CAcaller",
      actionUrl: "https://x/action",
      recordingStatusCallbackUrl: "https://x/rec",
    });
    expect(xml).toContain('action="https://x/action"');
    expect(xml).toContain('record="record-from-start"');
    expect(xml).toContain('recordingStatusCallback="https://x/rec"');
    expect(xml).toContain("<Conference");
    expect(xml).toContain(">CAcaller</Conference>");
  });
});
```

- [ ] **Step 6: Run test to verify it fails, then implement `src/twilio/conferenceTwiml.ts`**

```typescript
import { wrapResponse } from "./flowTwiml";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderJoinConference(opts: { conferenceName: string }): string {
  return wrapResponse(`<Dial><Conference>${escapeXml(opts.conferenceName)}</Conference></Dial>`);
}

export function renderDialAgentIntoConference(opts: {
  conferenceName: string;
  actionUrl: string;
  recordingStatusCallbackUrl: string;
}): string {
  return wrapResponse(
    `<Dial action="${escapeXml(opts.actionUrl)}" method="POST">` +
      `<Conference record="record-from-start" recordingStatusCallback="${escapeXml(opts.recordingStatusCallbackUrl)}" ` +
      `recordingStatusCallbackMethod="POST">${escapeXml(opts.conferenceName)}</Conference>` +
      `</Dial>`
  );
}
```

Run: `npx vitest run test/twilio/conferenceTwiml.test.ts` → PASS.

- [ ] **Step 7: Write the failing test for `handleAgentAnswer`'s new bridge behavior**

In `test/durable-objects/CallSession.test.ts`, find the existing test(s) covering `agent_answer` (the one asserting the response TwiML contains `<Dial>...<Queue>`). Update it: mock/stub `redirectCall` (via the same `vi.stubGlobal("fetch", ...)` pattern the file already uses for `createOutboundCall`) and assert:
1. A `fetch` call was made to `.../Calls/{callSid}.json` with `Url` containing `/webhooks/twilio/join-conference?conf={callSid}`.
2. The returned TwiML contains `<Conference` and the call's own `callSid` as the conference name, NOT `<Queue>`.

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run test/durable-objects/CallSession.test.ts -t "agent_answer"`
Expected: FAIL — `handleAgentAnswer` still renders `renderDialIntoQueue`.

- [ ] **Step 9: Implement — rewrite `handleAgentAnswer`**

In `src/durable-objects/CallSession.ts`:

Replace the imports `renderDialIntoQueue` (from `queueTwiml`) is no longer used by this method but IS still used elsewhere in the file (nowhere else, actually — check: `renderDialIntoQueue` was only ever called from `handleAgentAnswer`, so remove it from the `queueTwiml` import entirely) and add:
```typescript
import { redirectCall } from "../twilio/restClient"; // alongside the existing createOutboundCall, cancelCall import
import { renderDialAgentIntoConference } from "../twilio/conferenceTwiml";
```

Replace the method body:
```typescript
private async handleAgentAnswer(body: AgentAnswerEvent): Promise<Response> {
  const origin = new URL(body.webhookUrl).origin;
  const activeRing = await this.ctx.storage.get<ActiveRing>("activeRing");

  if (activeRing && activeRing.ringPlanState.name === "DIALING") {
    const { state, commands } = reduceRingPlan(activeRing.ringPlanState, { type: "ATTEMPT_ANSWERED" });
    if (commands.some((c) => c.type === "CANCEL_OTHER_ATTEMPTS")) {
      for (const sid of activeRing.attemptSids) {
        if (sid !== body.agentCallSid) await this.cancelStaff(sid);
      }
    }
    activeRing.ringPlanState = state;
    await this.ctx.storage.put("activeRing", activeRing);
  }

  await redirectCall(
    this.env.TWILIO_ACCOUNT_SID,
    this.env.TWILIO_AUTH_TOKEN,
    body.callSid,
    `${origin}/webhooks/twilio/join-conference?conf=${body.callSid}`
  );

  return this.xml(
    renderDialAgentIntoConference({
      conferenceName: body.callSid,
      actionUrl: `${origin}/webhooks/twilio/agent-status?callSid=${body.callSid}`,
      recordingStatusCallbackUrl: `${origin}/webhooks/twilio/recording-status?callSid=${body.callSid}`,
    })
  );
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/durable-objects/CallSession.test.ts`
Expected: PASS — including every pre-existing case, confirming the ring/hold/cascade/star-press machinery is untouched.

- [ ] **Step 11: Add the `/webhooks/twilio/join-conference` route**

In `src/worker.ts`, add the import `import { renderJoinConference } from "./twilio/conferenceTwiml";`. Add a new route block, placed alongside the other `/webhooks/twilio/*` routes:

```typescript
if (url.pathname === "/webhooks/twilio/join-conference" && request.method === "POST") {
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
  const conferenceName = url.searchParams.get("conf");
  if (!conferenceName) {
    return new Response("missing conf", { status: 400 });
  }
  return new Response(renderJoinConference({ conferenceName }), { headers: { "Content-Type": "text/xml" } });
}
```

- [ ] **Step 12: Write the failing test, then confirm**

Add to `test/worker.test.ts`: POST a validly-signed request to `/webhooks/twilio/join-conference?conf=CAcaller` and assert the response contains `<Conference>CAcaller</Conference>`; also assert a request missing `conf` returns 400.

Run: `npx vitest run test/worker.test.ts -t "join-conference"`
Expected: FAIL, then PASS once Step 11 is confirmed in place.

- [ ] **Step 13: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "Bridge answered ring calls into a real Twilio Conference"
```

---

## Task 5: Access Token minting

**Files:**
- Create: `src/twilio/accessToken.ts`
- Create: `src/api/softphone.ts` (this task only adds `handleGetSoftphoneToken`; Task 6 extends the same file)
- Modify: `src/worker.ts` — `GET /api/softphone/token` route, new env vars
- Test: `test/twilio/accessToken.test.ts`, `test/api/softphone.test.ts`

**Interfaces:**
- Produces: `mintAccessToken(opts: {accountSid: string; apiKeySid: string; apiKeySecret: string; twimlAppSid: string; identity: string}): Promise<string>` (`accessToken.ts`); `handleGetSoftphoneToken(env, staff): Promise<Response>` (`softphone.ts`).

- [ ] **Step 1: Write the failing test for `mintAccessToken`**

```typescript
// test/twilio/accessToken.test.ts
import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { mintAccessToken } from "../../src/twilio/accessToken";

describe("mintAccessToken", () => {
  it("mints a JWT with the Twilio Access Token header and grants, verifiable with the API key secret", async () => {
    const token = await mintAccessToken({
      accountSid: "ACxxx",
      apiKeySid: "SKxxx",
      apiKeySecret: "shh",
      twimlAppSid: "APxxx",
      identity: "phill@tcbpestcontrolcanberra.com.au",
    });

    const key = new TextEncoder().encode("shh");
    const { payload, protectedHeader } = await jwtVerify(token, key);

    expect(protectedHeader.cty).toBe("twilio-fpa;v=1");
    expect(payload.iss).toBe("SKxxx");
    expect(payload.sub).toBe("ACxxx");
    expect((payload.grants as any).identity).toBe("phill@tcbpestcontrolcanberra.com.au");
    expect((payload.grants as any).voice.incoming.allow).toBe(true);
    expect((payload.grants as any).voice.outgoing.application_sid).toBe("APxxx");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/twilio/accessToken.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/twilio/accessToken.ts`**

```typescript
import { SignJWT } from "jose";

const TOKEN_TTL_SECONDS = 3600;

export async function mintAccessToken(opts: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
}): Promise<string> {
  const key = new TextEncoder().encode(opts.apiKeySecret);
  return new SignJWT({
    grants: {
      identity: opts.identity,
      voice: { incoming: { allow: true }, outgoing: { application_sid: opts.twimlAppSid } },
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" })
    .setIssuer(opts.apiKeySid)
    .setSubject(opts.accountSid)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS)
    .sign(key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/twilio/accessToken.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the token endpoint**

```typescript
// test/api/softphone.test.ts
import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { handleGetSoftphoneToken } from "../../src/api/softphone";

describe("handleGetSoftphoneToken", () => {
  it("returns a token scoped to the requesting staff member's identity", async () => {
    const env = {
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_API_KEY_SID: "SKxxx",
      TWILIO_API_KEY_SECRET: "shh",
      TWILIO_TWIML_APP_SID: "APxxx",
    };
    const res = await handleGetSoftphoneToken(env, { email: "a@b.com", role: "staff" });
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    const { payload } = await jwtVerify(token, new TextEncoder().encode("shh"));
    expect((payload.grants as any).identity).toBe("a@b.com");
  });
});
```

- [ ] **Step 6: Run test to verify it fails, then implement**

Run: `npx vitest run test/api/softphone.test.ts` → FAIL — `src/api/softphone.ts` doesn't exist.

```typescript
// src/api/softphone.ts
import { jsonResponse } from "./respond";
import { mintAccessToken } from "../twilio/accessToken";
import type { StaffUser } from "../access/requireStaffUser";

type Env = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_TWIML_APP_SID: string;
};

export async function handleGetSoftphoneToken(env: Env, staff: StaffUser): Promise<Response> {
  const token = await mintAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: env.TWILIO_API_KEY_SID,
    apiKeySecret: env.TWILIO_API_KEY_SECRET,
    twimlAppSid: env.TWILIO_TWIML_APP_SID,
    identity: staff.email,
  });
  return jsonResponse({ token });
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/api/softphone.test.ts` → PASS.

- [ ] **Step 8: Wire the route into `worker.ts`**

Add `TWILIO_API_KEY_SID: string; TWILIO_API_KEY_SECRET: string; TWILIO_TWIML_APP_SID: string;` to the `Env` type. Add the import `import { handleGetSoftphoneToken } from "./api/softphone";`. Add the route (any authenticated staff, no admin check):
```typescript
if (url.pathname === "/api/softphone/token" && request.method === "GET") {
  return handleGetSoftphoneToken(env, staff);
}
```
Add placeholder vars to `wrangler.jsonc`'s `vars` block: `"TWILIO_API_KEY_SID": "REPLACE_ME"`, `"TWILIO_TWIML_APP_SID": "REPLACE_ME"` (the secret itself is set via `wrangler secret put` in Task 12, matching the existing `TWILIO_AUTH_TOKEN` convention).

- [ ] **Step 9: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green (note: `npm run typecheck`/`npm test` will pass locally even with `REPLACE_ME` placeholders — they're only exercised against the real Twilio API in Task 12).

```bash
git add -A
git commit -m "Add Twilio Access Token minting and the softphone token endpoint"
```

---

## Task 6: Presence control API — status, heartbeat, staff roster, schedule

**Files:**
- Modify: `src/api/softphone.ts` — add `handlePutPresence`, `handlePostHeartbeat`
- Create: `src/api/staff.ts` — `handleGetStaffRoster`, `handlePutStaffSchedule`
- Modify: `src/worker.ts` — new routes
- Test: `test/api/softphone.test.ts`, `test/api/staff.test.ts`

**Interfaces:**
- Produces: `handlePutPresence(request, db, staff): Promise<Response>`, `handlePostHeartbeat(db, staff): Promise<Response>` (`softphone.ts`); `handleGetStaffRoster(db): Promise<Response>`, `handlePutStaffSchedule(request, db, email, staff): Promise<Response>` (`staff.ts`).
- Consumes: `setStaffStatus`, `touchHeartbeat`, `getStaffRoster`, `setStaffSchedule` (Task 1, `src/db/staff.ts`); `forbiddenUnlessAdmin`-equivalent (reimplemented locally in `staff.ts` since it's not exported from `settings.ts` — copy the identical one-line check, matching the existing per-module-owns-its-own-guard convention already established between `settings.ts` and `ivrFlow.ts`).

- [ ] **Step 1: Write the failing test for presence + heartbeat**

Add to `test/api/softphone.test.ts`:

```typescript
describe("handlePutPresence", () => {
  it("rejects an invalid status", async () => {
    const res = await handlePutPresence(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ status: "busy" }) }),
      env.DB,
      { email: "a@b.com", role: "staff" }
    );
    expect(res.status).toBe(400);
  });

  it("updates the caller's own status and awayReason", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const res = await handlePutPresence(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ status: "away", awayReason: "lunch" }) }),
      env.DB,
      { email: "a@b.com", role: "staff" }
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, away_reason FROM staff_users WHERE email = 'a@b.com'").first();
    expect(row).toEqual({ status: "away", away_reason: "lunch" });
  });
});

describe("handlePostHeartbeat", () => {
  it("touches the caller's own heartbeat", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const before = Date.now();
    const res = await handlePostHeartbeat(env.DB, { email: "a@b.com", role: "staff" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT last_heartbeat_at FROM staff_users WHERE email = 'a@b.com'").first<{ last_heartbeat_at: number }>();
    expect(row!.last_heartbeat_at).toBeGreaterThanOrEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then implement**

Run: `npx vitest run test/api/softphone.test.ts -t "handlePutPresence|handlePostHeartbeat"` → FAIL.

Add to `src/api/softphone.ts`:
```typescript
import { setStaffStatus, touchHeartbeat } from "../db/staff";

function isValidStatus(value: unknown): value is "available" | "away" | "offline" {
  return value === "available" || value === "away" || value === "offline";
}

export async function handlePutPresence(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { status, awayReason } = body as Record<string, unknown>;
  if (!isValidStatus(status)) return new Response("invalid request body", { status: 400 });
  if (awayReason !== undefined && typeof awayReason !== "string" && awayReason !== null) {
    return new Response("invalid request body", { status: 400 });
  }
  await setStaffStatus(db, staff.email, status, (awayReason as string | null | undefined) ?? null);
  return jsonResponse({ ok: true });
}

export async function handlePostHeartbeat(db: D1Database, staff: StaffUser): Promise<Response> {
  await touchHeartbeat(db, staff.email);
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run test/api/softphone.test.ts` → PASS.

- [ ] **Step 4: Write the failing test for the staff roster + schedule endpoints**

```typescript
// test/api/staff.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGetStaffRoster, handlePutStaffSchedule } from "../../src/api/staff";

const SCHEDULE = { mon: { open: "09:00", close: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

describe("handleGetStaffRoster", () => {
  it("lists every staff member's email/role/status", async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const res = await handleGetStaffRoster(env.DB);
    const roster = await res.json<{ email: string }[]>();
    expect(roster.map((r) => r.email)).toEqual(["a@b.com"]);
  });
});

describe("handlePutStaffSchedule", () => {
  it("rejects non-admins", async () => {
    const res = await handlePutStaffSchedule(
      new Request("http://x", { method: "PUT", body: JSON.stringify(SCHEDULE) }),
      env.DB,
      "a@b.com",
      { email: "staff@b.com", role: "staff" }
    );
    expect(res.status).toBe(403);
  });

  it("saves a valid schedule for an admin", async () => {
    await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES ('a@b.com', 'staff', ?)").bind(Date.now()).run();
    const res = await handlePutStaffSchedule(
      new Request("http://x", { method: "PUT", body: JSON.stringify(SCHEDULE) }),
      env.DB,
      "a@b.com",
      { email: "admin@b.com", role: "admin" }
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT schedule FROM staff_users WHERE email = 'a@b.com'").first<{ schedule: string }>();
    expect(JSON.parse(row!.schedule)).toEqual(SCHEDULE);
  });
});
```

- [ ] **Step 5: Run test to verify it fails, then implement `src/api/staff.ts`**

Run: `npx vitest run test/api/staff.test.ts` → FAIL — module doesn't exist.

```typescript
import { jsonResponse } from "./respond";
import { getStaffRoster, setStaffSchedule } from "../db/staff";
import type { StaffUser } from "../access/requireStaffUser";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_RE = /^\d{2}:\d{2}$/;

function isDayWindow(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return typeof w.open === "string" && TIME_RE.test(w.open) && typeof w.close === "string" && TIME_RE.test(w.close);
}

function isSchedule(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return DAY_KEYS.length === Object.keys(s).length && DAY_KEYS.every((d) => Object.prototype.hasOwnProperty.call(s, d) && isDayWindow(s[d]));
}

export async function handleGetStaffRoster(db: D1Database): Promise<Response> {
  const roster = await getStaffRoster(db);
  return jsonResponse(roster.map((s) => ({ email: s.email, role: s.role, status: s.status })));
}

export async function handlePutStaffSchedule(request: Request, db: D1Database, email: string, staff: StaffUser): Promise<Response> {
  if (staff.role !== "admin") return new Response("forbidden", { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (!isSchedule(body)) return new Response("invalid request body", { status: 400 });
  await setStaffSchedule(db, email, body as any);
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/api/staff.test.ts` → PASS.

- [ ] **Step 7: Wire routes into `worker.ts`**

Add imports `handlePutPresence, handlePostHeartbeat` (from `./api/softphone`) and `handleGetStaffRoster, handlePutStaffSchedule` (from `./api/staff`). Add routes:
```typescript
if (url.pathname === "/api/softphone/presence" && request.method === "PUT") {
  return handlePutPresence(request, env.DB, staff);
}
if (url.pathname === "/api/softphone/heartbeat" && request.method === "POST") {
  return handlePostHeartbeat(env.DB, staff);
}
if (url.pathname === "/api/staff" && request.method === "GET") {
  return handleGetStaffRoster(env.DB);
}
const staffScheduleMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/schedule$/);
if (staffScheduleMatch && request.method === "PUT") {
  return handlePutStaffSchedule(request, env.DB, decodeURIComponent(staffScheduleMatch[1]), staff);
}
```

- [ ] **Step 8: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "Add presence toggle, heartbeat, staff roster, and per-staff schedule endpoints"
```

---

## Task 7: Hold & transfer API

**Files:**
- Modify: `src/api/softphone.ts` — add `handlePostHold`, `handlePostTransfer`, `handlePostCompleteTransfer`
- Modify: `src/worker.ts` — new routes + `/webhooks/twilio/transfer-answer`
- Test: `test/api/softphone.test.ts`, `test/worker.test.ts`

**Interfaces:**
- Produces: `handlePostHold(request, env, staff): Promise<Response>`, `handlePostTransfer(request, env, staff): Promise<Response>`, `handlePostCompleteTransfer(request, env, staff): Promise<Response>`.
- Consumes: `findConferenceSid`, `setParticipantHold`, `removeParticipant` (Task 4, `conferenceClient.ts`); `createOutboundCall` (existing, `restClient.ts`); `renderDialAgentIntoConference` (Task 4, `conferenceTwiml.ts`).

- [ ] **Step 1: Write the failing test for hold**

Add to `test/api/softphone.test.ts`:

```typescript
describe("handlePostHold", () => {
  it("looks up the conference and sets Hold on the given participant", async () => {
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const setHold = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAcaller", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: findSid, setParticipantHold: setHold }
    );
    expect(res.status).toBe(200);
    expect(findSid).toHaveBeenCalledWith("ACxxx", "authtoken", "CAcaller");
    expect(setHold).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAcaller", true);
  });

  it("404s when the conference can't be found", async () => {
    const res = await handlePostHold(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAcaller", hold: true }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: vi.fn().mockResolvedValue(null), setParticipantHold: vi.fn() }
    );
    expect(res.status).toBe(404);
  });
});
```

Note the fourth parameter: `handlePostHold`/`handlePostTransfer`/`handlePostCompleteTransfer` take their Twilio conference-client functions as an injected dependency object (default-valued to the real imports) rather than importing them directly — this is a deliberate, small deviation from this codebase's usual "import the real thing" convention, needed because these handlers make *multiple* sequenced Twilio REST calls per request and asserting the sequence via `vi.stubGlobal("fetch", ...)` mocking (the pattern used everywhere else) would require fragile call-order assumptions across two different REST resources. Dependency injection keeps the tests focused on this handler's own branching logic.

- [ ] **Step 2: Run test to verify it fails, then implement `handlePostHold`**

Run: `npx vitest run test/api/softphone.test.ts -t "handlePostHold"` → FAIL.

Add to `src/api/softphone.ts`:
```typescript
import { findConferenceSid as realFindConferenceSid, setParticipantHold as realSetParticipantHold, removeParticipant as realRemoveParticipant } from "../twilio/conferenceClient";
import { createOutboundCall as realCreateOutboundCall } from "../twilio/restClient";
import { renderDialAgentIntoConference } from "../twilio/conferenceTwiml";

type TwilioEnv = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string };

type ConferenceDeps = {
  findConferenceSid: typeof realFindConferenceSid;
  setParticipantHold: typeof realSetParticipantHold;
};

export async function handlePostHold(
  request: Request,
  env: TwilioEnv,
  _staff: StaffUser,
  deps: ConferenceDeps = { findConferenceSid: realFindConferenceSid, setParticipantHold: realSetParticipantHold }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { conferenceName, callSid, hold } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof callSid !== "string" || typeof hold !== "boolean") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  await deps.setParticipantHold(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, callSid, hold);
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run test/api/softphone.test.ts -t "handlePostHold"` → PASS.

- [ ] **Step 4: Write the failing test for transfer + complete-transfer**

```typescript
describe("handlePostTransfer", () => {
  it("dials the target identity into the same conference and returns the new leg's sid", async () => {
    const dial = vi.fn().mockResolvedValue({ sid: "CAtransfer" });
    const res = await handlePostTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", targetEmail: "b@b.com" }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken", TWILIO_FROM_NUMBER: "+61800000000" },
      { email: "a@b.com", role: "staff" },
      { createOutboundCall: dial }
    );
    expect(res.status).toBe(200);
    expect(dial).toHaveBeenCalledWith(
      "ACxxx", "authtoken",
      expect.objectContaining({ to: "client:b@b.com", from: "+61800000000" })
    );
    expect(await res.json()).toEqual({ sid: "CAtransfer" });
  });
});

describe("handlePostCompleteTransfer", () => {
  it("looks up the conference and removes the given participant", async () => {
    const findSid = vi.fn().mockResolvedValue("CFxxx");
    const remove = vi.fn().mockResolvedValue(undefined);
    const res = await handlePostCompleteTransfer(
      new Request("http://x", { method: "POST", body: JSON.stringify({ conferenceName: "CAcaller", callSid: "CAoriginalAgent" }) }),
      { TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_AUTH_TOKEN: "authtoken" },
      { email: "a@b.com", role: "staff" },
      { findConferenceSid: findSid, removeParticipant: remove }
    );
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("ACxxx", "authtoken", "CFxxx", "CAoriginalAgent");
  });
});
```

- [ ] **Step 5: Run test to verify it fails, then implement**

Run: `npx vitest run test/api/softphone.test.ts -t "handlePostTransfer|handlePostCompleteTransfer"` → FAIL.

Add to `src/api/softphone.ts`:
```typescript
type OutboundEnv = TwilioEnv & { TWILIO_FROM_NUMBER: string };
type DialDeps = { createOutboundCall: typeof realCreateOutboundCall };
type RemoveDeps = { findConferenceSid: typeof realFindConferenceSid; removeParticipant: typeof realRemoveParticipant };

export async function handlePostTransfer(
  request: Request,
  env: OutboundEnv,
  _staff: StaffUser,
  deps: DialDeps = { createOutboundCall: realCreateOutboundCall }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { conferenceName, targetEmail } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof targetEmail !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  const { sid } = await deps.createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
    to: `client:${targetEmail}`,
    from: env.TWILIO_FROM_NUMBER,
    url: `https://placeholder/webhooks/twilio/transfer-answer?conf=${conferenceName}`,
  });
  return jsonResponse({ sid });
}

export async function handlePostCompleteTransfer(
  request: Request,
  env: TwilioEnv,
  _staff: StaffUser,
  deps: RemoveDeps = { findConferenceSid: realFindConferenceSid, removeParticipant: realRemoveParticipant }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response("invalid request body", { status: 400 });
  const { conferenceName, callSid } = body as Record<string, unknown>;
  if (typeof conferenceName !== "string" || typeof callSid !== "string") {
    return new Response("invalid request body", { status: 400 });
  }
  const conferenceSid = await deps.findConferenceSid(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceName);
  if (!conferenceSid) return new Response("conference not found", { status: 404 });
  await deps.removeParticipant(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, conferenceSid, callSid);
  return jsonResponse({ ok: true });
}
```

Note the test's `url` expectation for `handlePostTransfer` doesn't check the exact origin — the real call site (Step 7 below) passes the real request origin; the test only asserts `to`/`from`, matching the existing looser-assertion style already used for `createOutboundCall`'s other callers in this codebase.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/api/softphone.test.ts` → PASS.

- [ ] **Step 7: Wire routes into `worker.ts`, including the transfer-answer webhook**

Add routes:
```typescript
if (url.pathname === "/api/softphone/hold" && request.method === "POST") {
  return handlePostHold(request, env, staff);
}
if (url.pathname === "/api/softphone/transfer" && request.method === "POST") {
  // Rebuild the request with the real origin baked into the target leg's answer-webhook URL,
  // since handlePostTransfer's own signature takes env, not the request origin.
  const bodyText = await request.text();
  const parsed = JSON.parse(bodyText) as { conferenceName: string; targetEmail: string };
  const res = await handlePostTransfer(
    new Request(request.url, { method: "POST", body: bodyText }),
    env,
    staff
  );
  return res;
}
if (url.pathname === "/api/softphone/transfer/complete" && request.method === "POST") {
  return handlePostCompleteTransfer(request, env, staff);
}
if (url.pathname === "/webhooks/twilio/transfer-answer" && request.method === "POST") {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    params[key] = String(value);
  }
  const signature = request.headers.get("X-Twilio-Signature") ?? "";
  const valid = await verifyTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
  if (!valid) return new Response("invalid signature", { status: 401 });
  const conferenceName = url.searchParams.get("conf");
  if (!conferenceName) return new Response("missing conf", { status: 400 });
  return new Response(
    renderDialAgentIntoConference({
      conferenceName,
      actionUrl: `${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`,
      recordingStatusCallbackUrl: `${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}`,
    }),
    { headers: { "Content-Type": "text/xml" } }
  );
}
```

Correct the placeholder `https://placeholder` origin left in `handlePostTransfer` (Step 5) — actually thread the real origin through properly instead of the reconstruct-and-reparse shown above: change `handlePostTransfer`'s signature to accept `origin: string` as an explicit parameter (not derived from `env`), i.e. `handlePostTransfer(request, env, staff, origin, deps?)`, passed as `url.origin` from this call site, and update the transfer-answer URL construction inside the handler to `${origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}`. Update Step 5's test calls to pass a fourth `origin` argument (`"https://example.com"`) before the `deps` object, and assert the dialed `url` is `https://example.com/webhooks/twilio/transfer-answer?conf=CAcaller`. Re-run `test/api/softphone.test.ts` to confirm still green after this signature correction, then simplify this route block to a plain `return handlePostTransfer(request, env, staff, url.origin);` (removing the manual body-rebuild workaround entirely).

Add `import { renderDialAgentIntoConference } from "./twilio/conferenceTwiml";` if not already imported from Task 4, and `handlePostHold, handlePostTransfer, handlePostCompleteTransfer` from `./api/softphone`.

- [ ] **Step 8: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "Add hold and transfer API endpoints"
```

---

## Task 8: Outbound dialing from the softphone (TwiML Application route)

**Files:**
- Modify: `src/worker.ts` — new `POST /twiml/voice-app` route
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: `createOutboundCall` (existing, `restClient.ts`), `renderJoinConference`... actually the agent leg itself needs to join, not be dialed — see below.

- [ ] **Step 1: Write the failing test**

Add to `test/worker.test.ts`:

```typescript
it("POST /twiml/voice-app returns Conference TwiML for the agent leg and dials the target into the same conference", async () => {
  const dial = vi.fn().mockResolvedValue({ sid: "CAtarget" });
  vi.doMock("../src/twilio/restClient", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/twilio/restClient")>()),
    createOutboundCall: dial,
  }));
  const res = await postSignedTwilioWebhook("/twiml/voice-app", { CallSid: "CAagent", From: "client:a@b.com", To: "+61400000000" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<Conference");
  expect(body).toContain(">CAagent</Conference>");
});
```

(Follow this test file's existing pattern for mocking `createOutboundCall` — if the file already has an established mocking approach for it elsewhere, e.g. for the removed click-to-call tests before Task 2 deleted them, or for `CallSession.test.ts`'s `dialStaff` tests, use that exact approach instead of introducing `vi.doMock` if it's not already the file's convention.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/worker.test.ts -t "voice-app"`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the route**

In `src/worker.ts`, add:
```typescript
if (url.pathname === "/twiml/voice-app" && request.method === "POST") {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    params[key] = String(value);
  }
  const signature = request.headers.get("X-Twilio-Signature") ?? "";
  const valid = await verifyTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
  if (!valid) return new Response("invalid signature", { status: 401 });

  const conferenceName = params.CallSid; // the agent's own browser-originated leg
  const target = params.To;
  if (!target) return new Response("missing To", { status: 400 });

  await createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
    to: target,
    from: env.TWILIO_FROM_NUMBER,
    url: `${url.origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}`,
    statusCallback: `${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`,
    statusCallbackEvent: ["completed", "busy", "no-answer", "failed", "canceled"],
  });

  return new Response(
    renderDialAgentIntoConference({
      conferenceName,
      actionUrl: `${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`,
      recordingStatusCallbackUrl: `${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}`,
    }),
    { headers: { "Content-Type": "text/xml" } }
  );
}
```

This deliberately reuses `/webhooks/twilio/transfer-answer` as the target number's own answer-webhook (Task 7) — dialing a plain phone number into an existing named conference is exactly what that route already does (it doesn't care whether the caller identity is a customer's number or a transfer target), so no new webhook route is needed here. Add `createOutboundCall` to the existing `./twilio/restClient` import if not already present in `worker.ts` (it currently is not imported there — only used inside `CallSession.ts` and now `api/softphone.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/worker.test.ts -t "voice-app"` → PASS.

- [ ] **Step 5: Run the full suite, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "Add outbound softphone dialing via the TwiML Application route"
```

---

## Task 9: The `/phone` softphone dashboard page

**Files:**
- Create: `src/html/pages/phone.ts`
- Modify: `src/worker.ts` — `GET /admin/phone` route
- Modify: `src/html/layout.ts` — add the "Phone" nav item

**Interfaces:**
- Consumes: `GET /api/softphone/token`, `PUT /api/softphone/presence`, `POST /api/softphone/heartbeat`, `POST /api/softphone/hold`, `POST /api/softphone/transfer`, `POST /api/softphone/transfer/complete`, `GET /api/staff` (all built in Tasks 5-8).

This task is UI-heavy and, per this project's existing convention (the original IVR/dialer/settings pages were hand-verified in the browser rather than unit-tested pixel-by-pixel), is **manually verified** rather than covered by automated tests — there is nothing here that isn't already covered by the API-layer tests in Tasks 5-8.

- [ ] **Step 1: Add the nav item**

In `src/html/layout.ts`, add `{ href: "/admin/phone", label: "Phone", key: "phone" }` as the first entry of `NAV_ITEMS` (softphone is the staff home screen per the design).

- [ ] **Step 2: Build `src/html/pages/phone.ts`**

Render a page (via `renderLayout("Phone", "phone", body, { extraHead: TWILIO_SDK_SCRIPT_TAG })`) containing:
- A status control: three buttons/radios for Available / Away (revealing a text input for the reason) / Offline, wired to `PUT /api/softphone/presence` on change.
- A dial pad: a text input + digit buttons + a "Call" button that calls `device.connect({ params: { To: input.value } })`.
- An incoming-call banner (hidden by default) shown on the Voice SDK's `device.on("incoming", ...)` event, with Accept/Reject buttons.
- Active-call controls (hidden until a call is connected): Mute (toggles `call.mute(!call.isMuted())`), Hold (POSTs `/api/softphone/hold` with `{ conferenceName, callSid: call.parameters.CallSid, hold: !currentlyOnHold }`), Transfer (a staff picker sourced from `GET /api/staff`, POSTs `/api/softphone/transfer` then, once the transferring agent confirms via a "Complete transfer" button, POSTs `/api/softphone/transfer/complete`), Hangup (`call.disconnect()`).

Core Voice SDK wiring (the part that must be exactly right — everything above is standard form/button plumbing following this codebase's existing inline-`<script>` style, e.g. `src/html/pages/settings.ts`):

```javascript
let device = null;
let activeCall = null;

async function initDevice() {
  const res = await fetch('/api/softphone/token');
  const { token } = await res.json();
  device = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'] });
  device.on('incoming', function (call) {
    activeCall = call;
    showIncomingBanner(call);
    call.on('accept', onCallConnected);
    call.on('disconnect', onCallEnded);
  });
  await device.register();
}

function placeCall(to) {
  activeCall = device.connect({ params: { To: to } });
  activeCall.on('accept', onCallConnected);
  activeCall.on('disconnect', onCallEnded);
}

// Heartbeat: keep presence alive while this tab is open (Task 1's HEARTBEAT_STALE_MS is 60s; ping well under that).
setInterval(function () { fetch('/api/softphone/heartbeat', { method: 'POST' }); }, 20000);
fetch('/api/softphone/heartbeat', { method: 'POST' });

initDevice();
```

`TWILIO_SDK_SCRIPT_TAG` is a `<script src="https://sdk.twilio.com/js/voice/releases/2.11.0/twilio.min.js"></script>` constant at the top of the file — before finalizing the exact version pin, check `https://registry.npmjs.org/@twilio/voice-sdk` (or the CDN's own release listing) the same way the Drawflow version was resolved live in the IVR canvas work, rather than trusting this plan's guess.

- [ ] **Step 3: Wire the `/admin/phone` route in `worker.ts`**

```typescript
if (url.pathname === "/admin/phone") {
  return new Response(renderPhonePage(), { headers: { "Content-Type": "text/html" } });
}
```
(No data-loading needed server-side — everything is fetched client-side after the page loads, unlike the other admin pages.)

- [ ] **Step 4: Manual verification**

Start `wrangler dev`, log in via the dev auth bypass, open `/admin/phone`, and confirm: the page loads without console errors, the status toggle round-trips (`PUT /api/softphone/presence` returns 200, reload shows the persisted status), and `device.register()` resolves without throwing (confirms the token endpoint and SDK script tag are wired correctly) — placing/receiving a real call is deferred to Task 12's end-to-end verification, since that requires the real Twilio API Key/TwiML Application from Task 12.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the /phone softphone dashboard page"
```

---

## Task 10: Settings page — staff schedule editor

**Files:**
- Modify: `src/html/pages/settings.ts`
- Modify: `src/worker.ts` — thread staff roster data into the settings page render

**Interfaces:**
- Consumes: `GET /api/staff` (Task 6), `PUT /api/staff/:email/schedule` (Task 6).

Also UI-heavy; manually verified, matching Task 9.

- [ ] **Step 1: Add a staff schedule section**

In `src/html/pages/settings.ts`, add a section listing each staff member (fetched via `getStaffRoster(env.DB)`, threaded into `renderSettingsPage` as a new parameter, same pattern as `schedule`/`blocklist`) with the same day-checkbox/time-input markup already used for business hours (extract the day-row-rendering logic the business-hours form already uses into a small shared helper parameterized by a form-id prefix, rather than duplicating it — this file's business-hours section already has exactly this markup once; reuse it for N staff members instead of copy-pasting it). Each staff member's form PUTs to `/api/staff/{email}/schedule` on submit.

- [ ] **Step 2: Thread the roster through `worker.ts`'s settings page route**

Update the `GET /admin/settings` route's data loading to also call `getStaffRoster(env.DB)` and pass it to `renderSettingsPage`.

- [ ] **Step 3: Manual verification**

`wrangler dev` → `/admin/settings` → confirm the staff schedule section renders one row per seeded staff member, and saving a schedule change round-trips on reload.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Add per-staff working-hours schedule editor to Settings"
```

---

## Task 11: Desktop app — mic permission, tray, notifications

**Files:**
- Modify: `desktop/main.js`

- [ ] **Step 1: Point the app at `/phone`**

Change `DASHBOARD_URL` to `"https://tcb-voip.phill-abb.workers.dev/admin/phone"`.

- [ ] **Step 2: Grant microphone permission**

Add, before `createWindow()` is first called:
```javascript
const { session } = require("electron");
session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
  callback(permission === "media");
});
```

- [ ] **Step 3: Add a tray icon and keep the app alive when the window closes**

```javascript
const { Tray, Menu } = require("electron");
let tray = null;
let mainWindow = null;

function createTray() {
  tray = new Tray(require("path").join(__dirname, "icon.png")); // reuse whatever icon asset the NSIS build already references, if one exists; otherwise a minimal 16x16 PNG needs adding here
  tray.setToolTip("TCB Phone");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => mainWindow?.show() },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", () => mainWindow?.show());
}
```
Change `createWindow()` to assign into `mainWindow` instead of a local `win`, call `createTray()` once from `app.whenReady().then(...)` alongside `createWindow()`, and change the `window-all-closed` handler to hide rather than quit:
```javascript
app.on("window-all-closed", () => {
  // Softphone must stay reachable in the tray even with the window closed — do not quit here.
});
```
Add a window `close` handler on `mainWindow` that calls `event.preventDefault(); mainWindow.hide();` instead of letting the window actually close, so "closing" the window minimizes to tray rather than destroying it.

- [ ] **Step 4: Desktop notification on incoming call**

The renderer process (the `/phone` page's own JS, Task 9) cannot call Electron's `Notification` API directly — it runs in a sandboxed, `contextIsolation: true`, `nodeIntegration: false` webContents. Add a minimal preload script:
```javascript
// desktop/preload.js
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopBridge", {
  notifyIncomingCall: (fromLabel) => ipcRenderer.send("incoming-call", fromLabel),
});
```
Wire it into `createWindow()`'s `webPreferences`: `preload: require("path").join(__dirname, "preload.js")`.
In `main.js`, handle the IPC message:
```javascript
const { ipcMain, Notification } = require("electron");
ipcMain.on("incoming-call", (_event, fromLabel) => {
  const notification = new Notification({ title: "Incoming call", body: fromLabel || "Unknown caller" });
  notification.on("click", () => mainWindow?.show());
  notification.show();
});
```
In Task 9's `device.on('incoming', ...)` handler, add a call to `window.desktopBridge?.notifyIncomingCall(call.parameters.From)` (optional-chained since this must still work when the same page is opened in a plain browser tab, where `desktopBridge` won't exist).

- [ ] **Step 2 (revisit Task 9): wire the notification call**

Go back to `src/html/pages/phone.ts` (Task 9) and add the `window.desktopBridge?.notifyIncomingCall(...)` line inside the `device.on('incoming', ...)` handler, as described above.

- [ ] **Step 5: Manual verification**

Run `npm start` inside `desktop/`, confirm: the app opens directly to `/phone`; closing the window hides it to the tray instead of quitting; the tray icon's "Show"/"Quit" menu items work; granting mic access no longer shows a blocked-permission console error when `/phone`'s `device.register()` runs (cross-check against Task 9's manual verification, now inside Electron instead of a browser tab).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add mic permission, tray icon, and incoming-call notifications to the desktop app"
```

---

## Task 12: Operational — Twilio API Key + TwiML Application, deploy, verify end-to-end

Not dispatchable to a subagent — requires interactive access to the Twilio Console and real phone calls, same as the original calling-system plan's final task.

- [ ] Create a Twilio **API Key** (Standard) in Console → Account → API keys & tokens. Set the secret: `npx wrangler secret put TWILIO_API_KEY_SECRET`. Set `TWILIO_API_KEY_SID` in `wrangler.jsonc`'s `vars`.
- [ ] Create a Twilio **TwiML Application** in Console. Set its Voice Request URL to `https://tcb-voip.phill-abb.workers.dev/twiml/voice-app` (HTTP POST). Set `TWILIO_TWIML_APP_SID` in `wrangler.jsonc`'s `vars`.
- [ ] Apply migrations 0008 and 0009 remotely: `npx wrangler d1 migrations apply tcb-voip-db --remote`.
- [ ] `npx wrangler deploy`.
- [ ] Verify: go available in `/phone` (in the desktop app), call the business number from an outside phone, confirm the softphone rings and answering bridges audio both ways; mute, hold, and transfer to a second staff member (need at least one more `staff_users` row) all work; hang up and confirm the call appears correctly in `/admin/calls`; place an outbound call from `/phone`'s dial pad and confirm it rings the target with the business caller ID.
- [ ] Treat anything unexpected here (recording attribute placement, conference-join timing, Voice SDK codec issues) as expected first-real-call discovery — fix forward, the same convention the original calling-system plan used for its own final task.

---

## Self-Review Notes

- **Spec coverage:** Architecture Overview → Tasks 5, 8, 9. Data Model Changes → Task 1 (additions) + Task 2/3 (removals). Presence Resolution → Task 1 + Task 3. Call Flow → Task 4. Outbound → Task 8. Dashboard & Desktop App → Tasks 9-11. Removed/Obsolete → Tasks 2-3. Call Blocklist → Task 2. Twilio Account Setup → Task 12.
- **Placeholder scan:** Task 9's version-pin note and Task 11's icon-asset note are explicit "verify/add this before finalizing" instructions with a stated reason, not unresolved TBDs — both are the same category of judgment call this codebase's own IVR canvas work already made (live-resolving the Drawflow CDN version rather than guessing).
- **Type consistency:** `RingNodeTarget` (`"all" | string[]`) is defined once in `src/dial/ringQueue.ts` (Task 3) and consumed by that same signature everywhere else it's referenced (`CallSession.ts`, `api/ivrFlow.ts`'s validator conceptually mirrors it without importing it, since that module doesn't currently import types from `dial/`). `StaffPresenceRow`/`StaffStatus` are defined once in `src/dial/presence.ts` (Task 1) and imported by `src/db/staff.ts`, never redefined.

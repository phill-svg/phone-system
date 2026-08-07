# TCB VoIP — Phase 1: Foundations + Telnyx Connectivity + IVR Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cloudflare Worker + D1 foundation, connect a real Telnyx phone number via its Call Control API, and implement the full IVR menu (greeting, recording-disclosure notice, business-hours branch, numeric menu, retry/timeout handling) as a testable state machine — ending with a real phone call that can navigate the whole menu, short of staff routing, recording, or transcription (later plans).

**Architecture:** A Cloudflare Worker receives Telnyx webhooks at `/webhooks/telnyx`, verifies their Ed25519 signature, and routes each event to a per-call Durable Object (`CallSession`) keyed by Telnyx's `call_control_id`. `CallSession` runs a pure, independently-tested IVR state machine (`ivr/stateMachine.ts`) and executes the commands it returns via a thin Telnyx REST client (`telnyx/client.ts`), logging every transition to D1.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1, TypeScript, Wrangler, Vitest + `@cloudflare/vitest-pool-workers`, Telnyx Call Control API v2.

## Global Constraints

- Business number and hours: Australia/Sydney IANA timezone (covers Canberra/ACT, no separate zone exists) — used for all business-hours checks.
- Recording-disclosure wording is fixed for this phase: `"This call may be recorded for quality and training purposes."` — confirm final wording with the business before go-live (tracked as a design risk, not blocking this plan).
- Menu prompt (fixed for this phase): `"Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone."`
- Gather timeout: 8000ms per attempt, 2 retries (3 total attempts) before falling through to voicemail.
- No staff ring list, no recording, no transcription in this plan — reaching `ROUTE_STAFF` or `VOICEMAIL` in the state machine is a terminal state for now (a later plan implements what happens inside them).
- Package manager: npm. Project root: `C:\Users\Phill\Claude\voip-phone-system`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `src/worker.ts`
- Create: `vitest.config.ts`
- Test: `test/worker.test.ts`

**Interfaces:**
- Produces: a deployable Worker with a `GET /health` route returning `200 "ok"` — later tasks add routes to the same `src/worker.ts` router.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tcb-voip",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.7.0",
    "@cloudflare/workers-types": "^4.20250801.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.90.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: installs without error, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2022"],
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 4: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "tcb-voip",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"]
}
```

- [ ] **Step 5: Write the failing test**

```ts
// test/worker.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker health check", () => {
  it("responds 200 ok on GET /health", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/worker.ts` does not exist / default export missing.

- [ ] **Step 8: Write minimal implementation**

```ts
// src/worker.ts
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git init
git add package.json tsconfig.json wrangler.jsonc vitest.config.ts src/worker.ts test/worker.test.ts
git commit -m "chore: scaffold tcb-voip Worker project"
```

---

### Task 2: D1 schema — `settings` and `calls`/`call_events` tables

**Files:**
- Create: `migrations/0001_init.sql`
- Modify: `wrangler.jsonc` (add D1 binding)
- Test: `test/db/migrations.test.ts`

**Interfaces:**
- Produces: D1 tables `settings(key TEXT PRIMARY KEY, value TEXT)`, `calls(id, caller_number, called_number, started_at, ivr_path, is_after_hours)`, `call_events(id, call_id, ts, event_type, detail)` — later tasks (`db/settings.ts`, `CallSession.ts`) read/write these by exact column name.

- [ ] **Step 1: Create the D1 database**

Run: `npx wrangler d1 create tcb-voip-db`
Expected: prints a `database_id` — copy it for the next step.

- [ ] **Step 2: Add the D1 binding to `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "tcb-voip",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "tcb-voip-db",
      "database_id": "<paste-the-id-from-step-1>",
      "migrations_dir": "migrations"
    }
  ]
}
```

- [ ] **Step 3: Create the migration file**

Run: `npx wrangler d1 migrations create tcb-voip-db init`
Expected: creates `migrations/0001_init.sql` (empty). Replace its contents with:

```sql
-- migrations/0001_init.sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE calls (
  id             TEXT PRIMARY KEY,
  caller_number  TEXT NOT NULL,
  called_number  TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  ivr_path       TEXT,
  is_after_hours INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL REFERENCES calls(id),
  ts         INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail     TEXT
);
```

- [ ] **Step 4: Write the failing test**

```ts
// test/db/migrations.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  it("has settings, calls, and call_events tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(["settings", "calls", "call_events"]));
  });
});
```

- [ ] **Step 5: Wire test migrations into `vitest.config.ts`**

```ts
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

```ts
// test/apply-migrations.ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 6: Run test to verify it fails, then apply migrations locally and re-run**

Run: `npm test`
Expected first run: FAIL if `wrangler.jsonc` wasn't updated yet — fix Step 2 first, then:

Run: `npx wrangler d1 migrations apply tcb-voip-db --local`
Run: `npm test`
Expected: PASS (the test harness applies the same migration files independently of the local dev DB, so this should already pass once Steps 2–5 are in place; running the `--local` apply is what makes `npm run dev` work later, not strictly required for the test to pass).

- [ ] **Step 7: Commit**

```bash
git add migrations/0001_init.sql wrangler.jsonc vitest.config.ts test/apply-migrations.ts test/db/migrations.test.ts
git commit -m "feat: add D1 schema for settings, calls, call_events"
```

---

### Task 3: Business-hours pure function

**Files:**
- Create: `src/ivr/businessHours.ts`
- Test: `test/ivr/businessHours.test.ts`

**Interfaces:**
- Produces: `isWithinBusinessHours(schedule: BusinessHoursSchedule, at: Date): boolean` and the `BusinessHoursSchedule` type — consumed by `db/settings.ts` (Task 4, for defaults) and `CallSession` (Task 8/9).

- [ ] **Step 1: Write the failing tests**

```ts
// test/ivr/businessHours.test.ts
import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, type BusinessHoursSchedule } from "../../src/ivr/businessHours";

const schedule: BusinessHoursSchedule = {
  mon: { open: "07:00", close: "17:00" },
  tue: { open: "07:00", close: "17:00" },
  wed: { open: "07:00", close: "17:00" },
  thu: { open: "07:00", close: "17:00" },
  fri: { open: "07:00", close: "17:00" },
  sat: { open: "08:00", close: "12:00" },
  sun: null,
};

// All test times are UTC instants that land on the stated local (Australia/Sydney) day/time.
describe("isWithinBusinessHours", () => {
  it("is true mid-morning on a weekday", () => {
    // Wed 2026-08-05 10:00 Australia/Sydney (AEST, UTC+10) = 2026-08-05T00:00:00Z
    expect(isWithinBusinessHours(schedule, new Date("2026-08-05T00:00:00Z"))).toBe(true);
  });

  it("is false before opening on a weekday", () => {
    // Wed 06:59 Australia/Sydney = Tue 20:59Z
    expect(isWithinBusinessHours(schedule, new Date("2026-08-04T20:59:00Z"))).toBe(false);
  });

  it("is true exactly at opening time (inclusive)", () => {
    expect(isWithinBusinessHours(schedule, new Date("2026-08-04T21:00:00Z"))).toBe(true);
  });

  it("is false exactly at closing time (exclusive)", () => {
    // Wed 17:00 Australia/Sydney = Wed 07:00Z
    expect(isWithinBusinessHours(schedule, new Date("2026-08-05T07:00:00Z"))).toBe(false);
  });

  it("is false on a day marked closed (Sunday)", () => {
    expect(isWithinBusinessHours(schedule, new Date("2026-08-09T02:00:00Z"))).toBe(false);
  });

  it("uses the Saturday-specific window", () => {
    // Sat 11:00 Australia/Sydney = Sat 01:00Z — within 08:00-12:00
    expect(isWithinBusinessHours(schedule, new Date("2026-08-08T01:00:00Z"))).toBe(true);
    // Sat 13:00 Australia/Sydney = Sat 03:00Z — after close
    expect(isWithinBusinessHours(schedule, new Date("2026-08-08T03:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- businessHours`
Expected: FAIL — `src/ivr/businessHours.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/ivr/businessHours.ts
export type DayWindow = { open: string; close: string } | null;

export type BusinessHoursSchedule = {
  mon: DayWindow;
  tue: DayWindow;
  wed: DayWindow;
  thu: DayWindow;
  fri: DayWindow;
  sat: DayWindow;
  sun: DayWindow;
};

const DAY_KEYS: (keyof BusinessHoursSchedule)[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME_ZONE = "Australia/Sydney";

function localParts(at: Date): { dayKey: keyof BusinessHoursSchedule; minutesSinceMidnight: number } {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(at);
  const weekdayShort = parts.find((p) => p.type === "weekday")!.value.toLowerCase();
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  const dayKey = DAY_KEYS.find((k) => weekdayShort.startsWith(k))!;
  return { dayKey, minutesSinceMidnight: hour * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinBusinessHours(schedule: BusinessHoursSchedule, at: Date): boolean {
  const { dayKey, minutesSinceMidnight } = localParts(at);
  const window = schedule[dayKey];
  if (!window) return false;
  const open = toMinutes(window.open);
  const close = toMinutes(window.close);
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- businessHours`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ivr/businessHours.ts test/ivr/businessHours.test.ts
git commit -m "feat: add business-hours pure function"
```

---

### Task 4: Settings D1 helpers

**Files:**
- Create: `src/db/settings.ts`
- Test: `test/db/settings.test.ts`

**Interfaces:**
- Consumes: `BusinessHoursSchedule` type from `src/ivr/businessHours.ts` (Task 3).
- Produces: `getBusinessHours(db: D1Database): Promise<BusinessHoursSchedule>` (returns a default Mon–Fri 7–5, Sat 8–12, Sun closed schedule if unset) and `setBusinessHours(db: D1Database, schedule: BusinessHoursSchedule): Promise<void>` — consumed by `CallSession` (Task 9) and, in a later dashboard plan, the Settings page.

- [ ] **Step 1: Write the failing tests**

```ts
// test/db/settings.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getBusinessHours, setBusinessHours } from "../../src/db/settings";

describe("settings.businessHours", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("returns a sensible default when nothing is stored", async () => {
    const schedule = await getBusinessHours(env.DB);
    expect(schedule.mon).toEqual({ open: "07:00", close: "17:00" });
    expect(schedule.sat).toEqual({ open: "08:00", close: "12:00" });
    expect(schedule.sun).toBeNull();
  });

  it("round-trips a custom schedule", async () => {
    const custom = {
      mon: { open: "08:00", close: "16:00" },
      tue: { open: "08:00", close: "16:00" },
      wed: { open: "08:00", close: "16:00" },
      thu: { open: "08:00", close: "16:00" },
      fri: { open: "08:00", close: "16:00" },
      sat: null,
      sun: null,
    };
    await setBusinessHours(env.DB, custom);
    expect(await getBusinessHours(env.DB)).toEqual(custom);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- settings`
Expected: FAIL — `src/db/settings.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/db/settings.ts
import type { BusinessHoursSchedule } from "../ivr/businessHours";

const BUSINESS_HOURS_KEY = "business_hours";

const DEFAULT_SCHEDULE: BusinessHoursSchedule = {
  mon: { open: "07:00", close: "17:00" },
  tue: { open: "07:00", close: "17:00" },
  wed: { open: "07:00", close: "17:00" },
  thu: { open: "07:00", close: "17:00" },
  fri: { open: "07:00", close: "17:00" },
  sat: { open: "08:00", close: "12:00" },
  sun: null,
};

export async function getBusinessHours(db: D1Database): Promise<BusinessHoursSchedule> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(BUSINESS_HOURS_KEY)
    .first<{ value: string }>();
  if (!row) return DEFAULT_SCHEDULE;
  return JSON.parse(row.value) as BusinessHoursSchedule;
}

export async function setBusinessHours(db: D1Database, schedule: BusinessHoursSchedule): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(BUSINESS_HOURS_KEY, JSON.stringify(schedule))
    .run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- settings`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/settings.ts test/db/settings.test.ts
git commit -m "feat: add settings D1 helpers for business hours"
```

---

### Task 5: Telnyx webhook signature verification

**Files:**
- Create: `src/telnyx/verifySignature.ts`
- Test: `test/telnyx/verifySignature.test.ts`

**Interfaces:**
- Produces: `verifyTelnyxSignature(rawBody: string, signatureHeader: string, timestampHeader: string, publicKeyBase64: string): Promise<boolean>` — consumed by `routes/telnyxWebhook.ts` (Task 9).

Telnyx signs webhooks with Ed25519: headers `telnyx-signature-ed25519` (base64 signature) and `telnyx-timestamp` (unix seconds); the signed message is `` `${timestamp}|${rawBody}` ``, verified against the account's Ed25519 public key from the Telnyx portal. Cloudflare Workers' `crypto.subtle` supports the `"Ed25519"` algorithm natively for `importKey`/`verify`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/telnyx/verifySignature.test.ts
import { describe, expect, it } from "vitest";
import { verifyTelnyxSignature } from "../../src/telnyx/verifySignature";

async function generateKeyPairBase64() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));
  return { privateKey: keyPair.privateKey, publicKeyBase64 };
}

async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe("verifyTelnyxSignature", () => {
  it("accepts a correctly signed payload", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeyPairBase64();
    const rawBody = JSON.stringify({ data: { event_type: "call.initiated" } });
    const timestamp = "1735689600";
    const signature = await sign(privateKey, `${timestamp}|${rawBody}`);
    expect(await verifyTelnyxSignature(rawBody, signature, timestamp, publicKeyBase64)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const { privateKey, publicKeyBase64 } = await generateKeyPairBase64();
    const timestamp = "1735689600";
    const signature = await sign(privateKey, `${timestamp}|original-body`);
    expect(await verifyTelnyxSignature("tampered-body", signature, timestamp, publicKeyBase64)).toBe(false);
  });

  it("rejects a signature from the wrong key", async () => {
    const { publicKeyBase64 } = await generateKeyPairBase64();
    const wrongPair = await generateKeyPairBase64();
    const rawBody = "some-body";
    const timestamp = "1735689600";
    const signature = await sign(wrongPair.privateKey, `${timestamp}|${rawBody}`);
    expect(await verifyTelnyxSignature(rawBody, signature, timestamp, publicKeyBase64)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- verifySignature`
Expected: FAIL — `src/telnyx/verifySignature.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/telnyx/verifySignature.ts
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function verifyTelnyxSignature(
  rawBody: string,
  signatureHeader: string,
  timestampHeader: string,
  publicKeyBase64: string
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64ToBytes(publicKeyBase64),
      { name: "Ed25519" },
      true,
      ["verify"]
    );
    const message = new TextEncoder().encode(`${timestampHeader}|${rawBody}`);
    const signature = base64ToBytes(signatureHeader);
    return await crypto.subtle.verify("Ed25519", publicKey, signature, message);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- verifySignature`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telnyx/verifySignature.ts test/telnyx/verifySignature.test.ts
git commit -m "feat: add Telnyx Ed25519 webhook signature verification"
```

---

### Task 6: Telnyx REST client wrapper

**Files:**
- Create: `src/telnyx/client.ts`
- Test: `test/telnyx/client.test.ts`

**Interfaces:**
- Produces: `createTelnyxClient(apiKey: string)` returning `{ answer(callControlId): Promise<void>, speak(callControlId, text): Promise<void>, gatherUsingSpeak(callControlId, opts): Promise<void>, hangup(callControlId): Promise<void> }` — consumed by `CallSession` (Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
// test/telnyx/client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelnyxClient } from "../../src/telnyx/client";

describe("telnyx client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("answer() posts to the answer action with the API key", async () => {
    const client = createTelnyxClient("test-key");
    await client.answer("call-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/call-123/actions/answer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      })
    );
  });

  it("speak() sends the payload text", async () => {
    const client = createTelnyxClient("test-key");
    await client.speak("call-123", "Hello there");
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.payload).toBe("Hello there");
  });

  it("gatherUsingSpeak() sends prompt, valid digits, and timeout", async () => {
    const client = createTelnyxClient("test-key");
    await client.gatherUsingSpeak("call-123", {
      prompt: "Press 1 or 2",
      validDigits: "12",
      timeoutMillis: 8000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telnyx.com/v2/calls/call-123/actions/gather_using_speak");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      payload: "Press 1 or 2",
      valid_digits: "12",
      inter_digit_timeout_millis: 8000,
      minimum_digits: 1,
      maximum_digits: 1,
    });
  });

  it("hangup() posts to the hangup action", async () => {
    const client = createTelnyxClient("test-key");
    await client.hangup("call-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/call-123/actions/hangup",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("bad request", { status: 422 }));
    const client = createTelnyxClient("test-key");
    await expect(client.answer("call-123")).rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- telnyx/client`
Expected: FAIL — `src/telnyx/client.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/telnyx/client.ts
const BASE_URL = "https://api.telnyx.com/v2";

async function callAction(apiKey: string, callControlId: string, action: string, body: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/calls/${callControlId}/actions/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Telnyx ${action} failed with status ${response.status}`);
  }
}

export type GatherOptions = {
  prompt: string;
  validDigits: string;
  timeoutMillis: number;
};

export function createTelnyxClient(apiKey: string) {
  return {
    answer(callControlId: string) {
      return callAction(apiKey, callControlId, "answer", {});
    },
    speak(callControlId: string, text: string) {
      return callAction(apiKey, callControlId, "speak", { payload: text, voice: "female" });
    },
    gatherUsingSpeak(callControlId: string, opts: GatherOptions) {
      return callAction(apiKey, callControlId, "gather_using_speak", {
        payload: opts.prompt,
        voice: "female",
        valid_digits: opts.validDigits,
        minimum_digits: 1,
        maximum_digits: 1,
        inter_digit_timeout_millis: opts.timeoutMillis,
      });
    },
    hangup(callControlId: string) {
      return callAction(apiKey, callControlId, "hangup", {});
    },
  };
}

export type TelnyxClient = ReturnType<typeof createTelnyxClient>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- telnyx/client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telnyx/client.ts test/telnyx/client.test.ts
git commit -m "feat: add Telnyx Call Control REST client (answer/speak/gather/hangup)"
```

---

### Task 7: IVR state machine (pure logic)

**Files:**
- Create: `src/ivr/stateMachine.ts`
- Test: `test/ivr/stateMachine.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — `isWithinBusinessHours` is called by the caller *before* constructing the initial event, not inside the machine, to keep this file free of Date/timezone concerns).
- Produces: `type IvrState`, `type IvrEvent`, `type IvrCommand`, and `reduce(state: IvrState, event: IvrEvent): { state: IvrState; commands: IvrCommand[] }` — consumed by `CallSession` (Task 9), which owns turning `IvrCommand`s into real Telnyx client calls and D1 writes.

State/event/command shapes:

```ts
type IvrState =
  | { name: "INCOMING" }
  | { name: "GREETING"; afterHours: boolean }
  | { name: "MAIN_MENU"; attempt: number }
  | { name: "AFTER_HOURS_MENU"; attempt: number }
  | { name: "ROUTE_STAFF"; tag: "new_booking" | "existing_job" | "emergency" | "operator" }
  | { name: "VOICEMAIL" };

type IvrEvent =
  | { type: "CALL_INITIATED"; isAfterHours: boolean }
  | { type: "GREETING_SPOKEN" }
  | { type: "DIGIT_RECEIVED"; digit: string }
  | { type: "GATHER_TIMED_OUT" };

type IvrCommand =
  | { type: "ANSWER" }
  | { type: "SPEAK"; text: string }
  | { type: "GATHER"; prompt: string; validDigits: string }
  | { type: "HANGUP" };
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/ivr/stateMachine.test.ts
import { describe, expect, it } from "vitest";
import { reduce, type IvrState } from "../../src/ivr/stateMachine";

describe("IVR state machine", () => {
  it("CALL_INITIATED (in hours) answers, plays disclosure, and moves to GREETING", () => {
    const { state, commands } = reduce({ name: "INCOMING" }, { type: "CALL_INITIATED", isAfterHours: false });
    expect(state).toEqual({ name: "GREETING", afterHours: false });
    expect(commands).toEqual([
      { type: "ANSWER" },
      { type: "SPEAK", text: "This call may be recorded for quality and training purposes." },
    ]);
  });

  it("CALL_INITIATED (after hours) plays the after-hours disclosure", () => {
    const { state, commands } = reduce({ name: "INCOMING" }, { type: "CALL_INITIATED", isAfterHours: true });
    expect(state).toEqual({ name: "GREETING", afterHours: true });
    expect(commands[1].type).toBe("SPEAK");
  });

  it("GREETING_SPOKEN (in hours) starts the main menu gather at attempt 1", () => {
    const { state, commands } = reduce({ name: "GREETING", afterHours: false }, { type: "GREETING_SPOKEN" });
    expect(state).toEqual({ name: "MAIN_MENU", attempt: 1 });
    expect(commands).toEqual([
      {
        type: "GATHER",
        prompt:
          "Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone.",
        validDigits: "0123",
      },
    ]);
  });

  it("GREETING_SPOKEN (after hours) starts the after-hours menu", () => {
    const { state } = reduce({ name: "GREETING", afterHours: true }, { type: "GREETING_SPOKEN" });
    expect(state).toEqual({ name: "AFTER_HOURS_MENU", attempt: 1 });
  });

  it.each([
    ["1", "new_booking"],
    ["2", "existing_job"],
    ["3", "emergency"],
    ["0", "operator"],
  ] as const)("MAIN_MENU digit %s routes to ROUTE_STAFF tag %s", (digit, tag) => {
    const { state, commands } = reduce({ name: "MAIN_MENU", attempt: 1 }, { type: "DIGIT_RECEIVED", digit });
    expect(state).toEqual({ name: "ROUTE_STAFF", tag });
    expect(commands).toEqual([]);
  });

  it("MAIN_MENU invalid digit re-prompts and increments the attempt", () => {
    const { state, commands } = reduce({ name: "MAIN_MENU", attempt: 1 }, { type: "DIGIT_RECEIVED", digit: "9" });
    expect(state).toEqual({ name: "MAIN_MENU", attempt: 2 });
    expect(commands[0]).toEqual({ type: "SPEAK", text: "Sorry, that wasn't a valid option." });
    expect(commands[1].type).toBe("GATHER");
  });

  it("MAIN_MENU invalid digit on the final attempt (3) goes to VOICEMAIL", () => {
    const { state, commands } = reduce({ name: "MAIN_MENU", attempt: 3 }, { type: "DIGIT_RECEIVED", digit: "9" });
    expect(state).toEqual({ name: "VOICEMAIL" });
    expect(commands.some((c) => c.type === "SPEAK")).toBe(true);
  });

  it("MAIN_MENU timeout re-prompts and increments the attempt", () => {
    const { state } = reduce({ name: "MAIN_MENU", attempt: 1 }, { type: "GATHER_TIMED_OUT" });
    expect(state).toEqual({ name: "MAIN_MENU", attempt: 2 });
  });

  it("MAIN_MENU timeout on the final attempt (3) goes to VOICEMAIL", () => {
    const { state } = reduce({ name: "MAIN_MENU", attempt: 3 }, { type: "GATHER_TIMED_OUT" });
    expect(state).toEqual({ name: "VOICEMAIL" });
  });

  it("AFTER_HOURS_MENU digit 1 routes to ROUTE_STAFF emergency", () => {
    const { state } = reduce({ name: "AFTER_HOURS_MENU", attempt: 1 }, { type: "DIGIT_RECEIVED", digit: "1" });
    expect(state).toEqual({ name: "ROUTE_STAFF", tag: "emergency" });
  });

  it("AFTER_HOURS_MENU timeout goes straight to VOICEMAIL (no retry)", () => {
    const { state } = reduce({ name: "AFTER_HOURS_MENU", attempt: 1 }, { type: "GATHER_TIMED_OUT" });
    expect(state).toEqual({ name: "VOICEMAIL" });
  });

  it("VOICEMAIL is terminal — commands include a HANGUP-free voicemail prompt", () => {
    const { commands } = reduce({ name: "MAIN_MENU", attempt: 3 }, { type: "GATHER_TIMED_OUT" });
    const speak = commands.find((c) => c.type === "SPEAK") as { type: "SPEAK"; text: string };
    expect(speak.text).toMatch(/leave a message/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stateMachine`
Expected: FAIL — `src/ivr/stateMachine.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/ivr/stateMachine.ts
export type IvrState =
  | { name: "INCOMING" }
  | { name: "GREETING"; afterHours: boolean }
  | { name: "MAIN_MENU"; attempt: number }
  | { name: "AFTER_HOURS_MENU"; attempt: number }
  | { name: "ROUTE_STAFF"; tag: "new_booking" | "existing_job" | "emergency" | "operator" }
  | { name: "VOICEMAIL" };

export type IvrEvent =
  | { type: "CALL_INITIATED"; isAfterHours: boolean }
  | { type: "GREETING_SPOKEN" }
  | { type: "DIGIT_RECEIVED"; digit: string }
  | { type: "GATHER_TIMED_OUT" };

export type IvrCommand =
  | { type: "ANSWER" }
  | { type: "SPEAK"; text: string }
  | { type: "GATHER"; prompt: string; validDigits: string }
  | { type: "HANGUP" };

const DISCLOSURE = "This call may be recorded for quality and training purposes.";
const AFTER_HOURS_NOTICE =
  "Thanks for calling TCB Pest Control. Our office is currently closed. " + DISCLOSURE;
const MAIN_MENU_PROMPT =
  "Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone.";
const AFTER_HOURS_MENU_PROMPT = "For a pest emergency, press 1. Otherwise, please leave a message after the tone.";
const INVALID_DIGIT_TEXT = "Sorry, that wasn't a valid option.";
const VOICEMAIL_PROMPT =
  "Sorry we're unable to take your call right now. Please leave a message after the tone, including your name and number.";
const MAX_MAIN_MENU_ATTEMPTS = 3;

const MAIN_MENU_ROUTES: Record<string, IvrState & { name: "ROUTE_STAFF" }> = {
  "1": { name: "ROUTE_STAFF", tag: "new_booking" },
  "2": { name: "ROUTE_STAFF", tag: "existing_job" },
  "3": { name: "ROUTE_STAFF", tag: "emergency" },
  "0": { name: "ROUTE_STAFF", tag: "operator" },
};

function toVoicemail(): { state: IvrState; commands: IvrCommand[] } {
  return { state: { name: "VOICEMAIL" }, commands: [{ type: "SPEAK", text: VOICEMAIL_PROMPT }] };
}

export function reduce(state: IvrState, event: IvrEvent): { state: IvrState; commands: IvrCommand[] } {
  if (state.name === "INCOMING" && event.type === "CALL_INITIATED") {
    return {
      state: { name: "GREETING", afterHours: event.isAfterHours },
      commands: [
        { type: "ANSWER" },
        { type: "SPEAK", text: event.isAfterHours ? AFTER_HOURS_NOTICE : DISCLOSURE },
      ],
    };
  }

  if (state.name === "GREETING" && event.type === "GREETING_SPOKEN") {
    if (state.afterHours) {
      return {
        state: { name: "AFTER_HOURS_MENU", attempt: 1 },
        commands: [{ type: "GATHER", prompt: AFTER_HOURS_MENU_PROMPT, validDigits: "1" }],
      };
    }
    return {
      state: { name: "MAIN_MENU", attempt: 1 },
      commands: [{ type: "GATHER", prompt: MAIN_MENU_PROMPT, validDigits: "0123" }],
    };
  }

  if (state.name === "MAIN_MENU") {
    if (event.type === "DIGIT_RECEIVED" && MAIN_MENU_ROUTES[event.digit]) {
      return { state: MAIN_MENU_ROUTES[event.digit], commands: [] };
    }
    if (event.type === "DIGIT_RECEIVED" || event.type === "GATHER_TIMED_OUT") {
      if (state.attempt >= MAX_MAIN_MENU_ATTEMPTS) return toVoicemail();
      const commands: IvrCommand[] =
        event.type === "DIGIT_RECEIVED"
          ? [
              { type: "SPEAK", text: INVALID_DIGIT_TEXT },
              { type: "GATHER", prompt: MAIN_MENU_PROMPT, validDigits: "0123" },
            ]
          : [{ type: "GATHER", prompt: MAIN_MENU_PROMPT, validDigits: "0123" }];
      return { state: { name: "MAIN_MENU", attempt: state.attempt + 1 }, commands };
    }
  }

  if (state.name === "AFTER_HOURS_MENU") {
    if (event.type === "DIGIT_RECEIVED" && event.digit === "1") {
      return { state: { name: "ROUTE_STAFF", tag: "emergency" }, commands: [] };
    }
    if (event.type === "DIGIT_RECEIVED" || event.type === "GATHER_TIMED_OUT") {
      return toVoicemail();
    }
  }

  throw new Error(`Unhandled event ${event.type} in state ${state.name}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- stateMachine`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ivr/stateMachine.ts test/ivr/stateMachine.test.ts
git commit -m "feat: add pure IVR state machine (greeting, menu, retries, voicemail routing)"
```

---

### Task 8: `CallSession` Durable Object — wire state machine to Telnyx

**Files:**
- Create: `src/durable-objects/CallSession.ts`
- Modify: `wrangler.jsonc` (add Durable Object binding + migration)
- Test: `test/durable-objects/CallSession.test.ts`

**Interfaces:**
- Consumes: `reduce` from `src/ivr/stateMachine.ts` (Task 7), `createTelnyxClient` from `src/telnyx/client.ts` (Task 6), `getBusinessHours`/`isWithinBusinessHours` (Tasks 3–4).
- Produces: `CallSession` class with `fetch(request: Request): Promise<Response>` accepting `POST /events` with a Telnyx webhook `data` payload (`{ event_type, payload: { call_control_id, from, to } }`) — consumed by the webhook route (Task 9). Writes one row to `calls` on `call.initiated` and one row to `call_events` per transition.

- [ ] **Step 1: Add the Durable Object binding to `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "tcb-voip",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "tcb-voip-db",
      "database_id": "<same-id-as-task-2>",
      "migrations_dir": "migrations"
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "CALL_SESSION", "class_name": "CallSession" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CallSession"] }],
  "vars": {
    "TELNYX_API_KEY": ""
  }
}
```

(`TELNYX_API_KEY` is set as a real secret via `wrangler secret put TELNYX_API_KEY` before deploying in Task 10 — the empty `vars` entry here only satisfies local typechecking/dev; it is overridden by the secret in every real environment.)

- [ ] **Step 2: Write the failing test**

```ts
// test/durable-objects/CallSession.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBusinessHours } from "../../src/db/settings";

const fetchMock = vi.fn();

function webhook(eventType: string, payload: Record<string, unknown>) {
  return new Request("https://internal/events", {
    method: "POST",
    body: JSON.stringify({ data: { event_type: eventType, payload } }),
  });
}

describe("CallSession", () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await env.DB.prepare("DELETE FROM calls").run();
    await env.DB.prepare("DELETE FROM call_events").run();
    await setBusinessHours(env.DB, {
      mon: { open: "00:00", close: "23:59" },
      tue: { open: "00:00", close: "23:59" },
      wed: { open: "00:00", close: "23:59" },
      thu: { open: "00:00", close: "23:59" },
      fri: { open: "00:00", close: "23:59" },
      sat: { open: "00:00", close: "23:59" },
      sun: { open: "00:00", close: "23:59" },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("call.initiated answers the call and writes a calls row", async () => {
    const id = env.CALL_SESSION.idFromName("call-abc");
    const stub = env.CALL_SESSION.get(id);
    const response = await runInDurableObject(stub, (instance) =>
      instance.fetch(
        webhook("call.initiated", { call_control_id: "call-abc", from: "+61400000000", to: "+61200000000" })
      )
    );
    expect(response.status).toBe(200);

    const answerCall = fetchMock.mock.calls.find(([url]) => (url as string).endsWith("/actions/answer"));
    expect(answerCall).toBeDefined();

    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind("call-abc").first();
    expect(row).toMatchObject({ id: "call-abc", caller_number: "+61400000000", called_number: "+61200000000" });

    const events = await env.DB.prepare("SELECT event_type FROM call_events WHERE call_id = ?")
      .bind("call-abc")
      .all();
    expect(events.results.map((e: any) => e.event_type)).toContain("state_transition");
  });

  it("call.dtmf.received with digit 1 progresses toward ROUTE_STAFF", async () => {
    const id = env.CALL_SESSION.idFromName("call-def");
    const stub = env.CALL_SESSION.get(id);
    await runInDurableObject(stub, (instance) =>
      instance.fetch(webhook("call.initiated", { call_control_id: "call-def", from: "+61400000001", to: "+61200000000" }))
    );
    await runInDurableObject(stub, (instance) => instance.fetch(webhook("call.speak.ended", { call_control_id: "call-def" })));
    await runInDurableObject(stub, (instance) =>
      instance.fetch(webhook("call.dtmf.received", { call_control_id: "call-def", digit: "1" }))
    );

    const row = await env.DB.prepare("SELECT ivr_path FROM calls WHERE id = ?").bind("call-def").first();
    expect(row).toMatchObject({ ivr_path: "new_booking" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- CallSession`
Expected: FAIL — `src/durable-objects/CallSession.ts` not found, and `env.CALL_SESSION` binding missing until Step 1 is applied (apply Step 1 first, then this fails only on the missing class).

- [ ] **Step 4: Write the implementation**

```ts
// src/durable-objects/CallSession.ts
import { DurableObject } from "cloudflare:workers";
import { createTelnyxClient, type TelnyxClient } from "../telnyx/client";
import { reduce, type IvrCommand, type IvrState } from "../ivr/stateMachine";
import { getBusinessHours } from "../db/settings";
import { isWithinBusinessHours } from "../ivr/businessHours";

type Env = {
  DB: D1Database;
  TELNYX_API_KEY: string;
};

export class CallSession extends DurableObject<Env> {
  private telnyx: TelnyxClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.telnyx = createTelnyxClient(env.TELNYX_API_KEY);
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      data: { event_type: string; payload: Record<string, any> };
    };
    const { event_type, payload } = body.data;
    const callControlId: string = payload.call_control_id;

    if (event_type === "call.initiated") {
      await this.handleCallInitiated(callControlId, payload.from, payload.to);
      return new Response("ok");
    }

    if (event_type === "call.speak.ended") {
      await this.applyEvent(callControlId, { type: "GREETING_SPOKEN" });
      return new Response("ok");
    }

    if (event_type === "call.dtmf.received") {
      await this.applyEvent(callControlId, { type: "DIGIT_RECEIVED", digit: payload.digit });
      return new Response("ok");
    }

    if (event_type === "call.gather.ended" && payload.status === "timeout") {
      await this.applyEvent(callControlId, { type: "GATHER_TIMED_OUT" });
      return new Response("ok");
    }

    return new Response("ignored");
  }

  private async handleCallInitiated(callControlId: string, from: string, to: string) {
    const schedule = await getBusinessHours(this.env.DB);
    const isAfterHours = !isWithinBusinessHours(schedule, new Date());

    await this.env.DB.prepare(
      "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(callControlId, from, to, Date.now(), isAfterHours ? 1 : 0)
      .run();

    await this.ctx.storage.put<IvrState>(`state:${callControlId}`, { name: "INCOMING" });
    await this.applyEvent(callControlId, { type: "CALL_INITIATED", isAfterHours });
  }

  private async applyEvent(callControlId: string, event: Parameters<typeof reduce>[1]) {
    const current = (await this.ctx.storage.get<IvrState>(`state:${callControlId}`)) ?? { name: "INCOMING" };
    const { state: next, commands } = reduce(current, event);
    await this.ctx.storage.put(`state:${callControlId}`, next);

    await this.env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind(callControlId, Date.now(), "state_transition", JSON.stringify({ event, next }))
      .run();

    if (next.name === "ROUTE_STAFF") {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?").bind(next.tag, callControlId).run();
    }
    if (next.name === "VOICEMAIL") {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?")
        .bind("voicemail", callControlId)
        .run();
    }

    for (const command of commands) {
      await this.executeCommand(callControlId, command);
    }
  }

  private async executeCommand(callControlId: string, command: IvrCommand) {
    switch (command.type) {
      case "ANSWER":
        return this.telnyx.answer(callControlId);
      case "SPEAK":
        return this.telnyx.speak(callControlId, command.text);
      case "GATHER":
        return this.telnyx.gatherUsingSpeak(callControlId, {
          prompt: command.prompt,
          validDigits: command.validDigits,
          timeoutMillis: 8000,
        });
      case "HANGUP":
        return this.telnyx.hangup(callControlId);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- CallSession`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add wrangler.jsonc src/durable-objects/CallSession.ts test/durable-objects/CallSession.test.ts
git commit -m "feat: add CallSession Durable Object driving the IVR state machine via Telnyx"
```

---

### Task 9: Webhook route — signature verification + routing to `CallSession`

**Files:**
- Modify: `src/worker.ts`
- Modify: `wrangler.jsonc` (add `TELNYX_PUBLIC_KEY` var placeholder, real value set as secret in Task 10)
- Test: `test/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyTelnyxSignature` (Task 5), `CallSession` DO binding `env.CALL_SESSION` (Task 8).
- Produces: `POST /webhooks/telnyx` route — the only externally-facing entry point Telnyx calls.

- [ ] **Step 1: Write the failing test (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add below the existing health-check test)
import { env } from "cloudflare:test";

describe("POST /webhooks/telnyx", () => {
  async function sign(privateKey: CryptoKey, message: string): Promise<string> {
    const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  it("rejects a request with an invalid signature", async () => {
    const response = await SELF.fetch("https://example.com/webhooks/telnyx", {
      method: "POST",
      headers: { "telnyx-signature-ed25519": "bad", "telnyx-timestamp": "123" },
      body: JSON.stringify({ data: { event_type: "call.initiated", payload: {} } }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts a validly signed call.initiated and forwards it to CallSession", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));
    env.TELNYX_PUBLIC_KEY = publicKeyBase64;

    const rawBody = JSON.stringify({
      data: {
        event_type: "call.initiated",
        payload: { call_control_id: "call-xyz", from: "+61400000002", to: "+61200000000" },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(keyPair.privateKey, `${timestamp}|${rawBody}`);

    const response = await SELF.fetch("https://example.com/webhooks/telnyx", {
      method: "POST",
      headers: { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp },
      body: rawBody,
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT id FROM calls WHERE id = ?").bind("call-xyz").first();
    expect(row).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/webhooks/telnyx` returns 404 (not found).

- [ ] **Step 3: Update `wrangler.jsonc`'s `vars` block**

```jsonc
"vars": {
  "TELNYX_API_KEY": "",
  "TELNYX_PUBLIC_KEY": ""
}
```

- [ ] **Step 4: Write the implementation**

```ts
// src/worker.ts
import { verifyTelnyxSignature } from "./telnyx/verifySignature";
export { CallSession } from "./durable-objects/CallSession";

type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/webhooks/telnyx" && request.method === "POST") {
      const rawBody = await request.text();
      const signature = request.headers.get("telnyx-signature-ed25519") ?? "";
      const timestamp = request.headers.get("telnyx-timestamp") ?? "";
      const valid = await verifyTelnyxSignature(rawBody, signature, timestamp, env.TELNYX_PUBLIC_KEY);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      const parsed = JSON.parse(rawBody) as { data: { payload: { call_control_id: string } } };
      const callControlId = parsed.data.payload.call_control_id;
      const id = env.CALL_SESSION.idFromName(callControlId);
      const stub = env.CALL_SESSION.get(id);
      await stub.fetch("https://internal/events", {
        method: "POST",
        body: rawBody,
        headers: { "Content-Type": "application/json" },
      });
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests across every task so far)

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts wrangler.jsonc test/worker.test.ts
git commit -m "feat: add /webhooks/telnyx route with signature verification and DO routing"
```

---

### Task 10: Telnyx account setup + real end-to-end test call

This task is operational, not code — it connects the system built in Tasks 1–9 to a real phone number.

- [ ] **Step 1: Create a Telnyx account and complete AU identity verification**

At telnyx.com, sign up, and submit the required ID/business documents for Australian number provisioning. This step has a lead time of roughly 72 hours — start it before you need the number.

- [ ] **Step 2: Purchase an Australian DID and create a Call Control Application**

In the Telnyx portal: Numbers → buy an AU number; Call Control → create an Application, and set its **Webhook URL** to `https://<your-worker-subdomain>.workers.dev/webhooks/telnyx`. Assign the new number to this Call Control Application's connection.

- [ ] **Step 3: Copy your Telnyx API key and Ed25519 public key**

Portal → API Keys (create one, copy it) and Portal → Public Key (copy the Ed25519 public key used for webhook signature verification — this is the value `TELNYX_PUBLIC_KEY` must hold, not your API key).

- [ ] **Step 4: Set the real secrets on the deployed Worker**

Run: `npx wrangler secret put TELNYX_API_KEY` (paste the API key when prompted)
Run: `npx wrangler secret put TELNYX_PUBLIC_KEY` (paste the Ed25519 public key when prompted)

- [ ] **Step 5: Apply migrations to the remote D1 database and deploy**

Run: `npx wrangler d1 migrations apply tcb-voip-db --remote`
Run: `npm run deploy`
Expected: deploy succeeds, prints the `*.workers.dev` URL used in Step 2.

- [ ] **Step 6: Place a real test call**

Call the new Telnyx AU number from any phone. Expected: you hear the recording-disclosure notice, then the main menu; pressing `1`, `2`, `3`, or `0` should each be silently accepted (no staff routing yet — that's a later plan), letting the call sit at that point; waiting out three timeouts or entering an invalid digit three times should play the voicemail prompt.

- [ ] **Step 7: Verify the D1 trail for that call**

Run: `npx wrangler d1 execute tcb-voip-db --remote --command "SELECT * FROM calls ORDER BY started_at DESC LIMIT 1"`
Run: `npx wrangler d1 execute tcb-voip-db --remote --command "SELECT event_type, detail FROM call_events WHERE call_id = '<id from previous query>' ORDER BY ts"`
Expected: the `calls` row shows the correct `caller_number`/`ivr_path`, and `call_events` shows the exact sequence of state transitions matching what you pressed on the phone.

- [ ] **Step 8: Test the after-hours branch**

Run: `npx wrangler d1 execute tcb-voip-db --remote --command "INSERT INTO settings (key, value) VALUES ('business_hours', '{\"mon\":null,\"tue\":null,\"wed\":null,\"thu\":null,\"fri\":null,\"sat\":null,\"sun\":null}') ON CONFLICT(key) DO UPDATE SET value = excluded.value"`

This marks every day closed. Call the number again — expect the after-hours notice and the "press 1 for emergency" menu instead of the main menu. Afterward, restore real business hours with the equivalent `INSERT ... ON CONFLICT` using your actual schedule.

---

## Self-Review Notes

- **Spec coverage:** This plan implements Build Phases 0–2 of the design spec (`docs/superpowers/specs/2026-08-07-tcb-voip-design.md`) in full — foundations, D1 schema (the subset needed so far), Telnyx answer/hangup/speak/gather, signature verification, webhook routing, and the complete IVR state machine including after-hours branching and retry/voicemail fallback. Phases 3–8 (staff ring/AMD/bridge, recording, transcription, listen-in, dashboard, ServiceM8, cutover) are intentionally out of scope — each becomes its own follow-up plan once this one is verified working end-to-end with a real call.
- **Type consistency:** `IvrState`/`IvrEvent`/`IvrCommand` names and shapes are defined once in Task 7 and reused verbatim in Task 8/9 tests and implementation. `BusinessHoursSchedule` is defined once in Task 3 and reused in Tasks 4 and 8.
- **No placeholders:** every step includes complete, runnable code; the one operational task (Task 10) is explicitly non-code and is scoped to portal/CLI actions with exact commands and expected results, not vague instructions.

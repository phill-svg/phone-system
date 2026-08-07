# TCB VoIP — Phase 1: Foundations + Twilio Connectivity + IVR Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Provider correction (2026-08-08):** this plan originally targeted Telnyx. Telnyx's self-service portal turned out to have no purchasable Australian numbers despite its marketing pages — confirmed directly by Phill. The provider is now **Twilio** (confirmed AU self-service number support). Tasks 1–4 and 7 (scaffold, D1 schema, business hours, settings, IVR state machine) are provider-agnostic and unaffected. Tasks 5, 6, 8, 9, 10 below are the Twilio-targeted rewrite, replacing the original Telnyx-specific versions.

**Goal:** Stand up the Cloudflare Worker + D1 foundation, connect a real Twilio phone number via its Programmable Voice API, and implement the full IVR menu (greeting, recording-disclosure notice, business-hours branch, numeric menu, retry/timeout handling) as a testable state machine — ending with a real phone call that can navigate the whole menu, short of staff routing, recording, or transcription (later plans).

**Architecture:** A Cloudflare Worker receives Twilio webhooks at `/webhooks/twilio` (a single endpoint reused as the `action` URL for every TwiML verb), verifies Twilio's `X-Twilio-Signature` header, and routes each request to a per-call Durable Object (`CallSession`) keyed by Twilio's `CallSid`. `CallSession` runs a pure, independently-tested IVR state machine (`ivr/stateMachine.ts`) and renders the commands it returns directly into a TwiML XML document (`twilio/twiml.ts`), returned synchronously as the webhook's HTTP response — Twilio's model has no separate async command-dispatch step, so there is no REST client to write for this phase. Every transition is logged to D1.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1, TypeScript, Wrangler, Vitest + `@cloudflare/vitest-pool-workers`, Twilio Programmable Voice (TwiML).

## Global Constraints

- Business number and hours: Australia/Sydney IANA timezone (covers Canberra/ACT, no separate zone exists) — used for all business-hours checks.
- Recording-disclosure wording is fixed for this phase: `"This call may be recorded for quality and training purposes."` — confirm final wording with the business before go-live (tracked as a design risk, not blocking this plan).
- Menu prompt (fixed for this phase): `"Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone."`
- Gather timeout: 8000ms per attempt, 2 retries (3 total attempts) before falling through to voicemail.
- No staff ring list, no recording, no transcription in this plan — reaching `ROUTE_STAFF` or `VOICEMAIL` in the state machine is terminal for now: the `CallSession` DO responds with the state's spoken prompt followed by an explicit `<Hangup/>` (there is no next step to hand the call to yet; a later plan replaces this with real staff-ring/voicemail-recording TwiML).
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

### Task 5: Twilio webhook signature verification

**Files:**
- Create: `src/twilio/verifySignature.ts`
- Test: `test/twilio/verifySignature.test.ts`

**Interfaces:**
- Produces: `verifyTwilioSignature(url: string, params: Record<string, string>, signatureHeader: string, authToken: string): Promise<boolean>` — consumed by `worker.ts` (Task 9).

Twilio signs webhooks with `X-Twilio-Signature`: `base64(HMAC-SHA1(authToken, url + sortedConcatenatedParams))`, where `sortedConcatenatedParams` is every POST param's key immediately followed by its value (no delimiters), sorted by key using case-sensitive Unix-style ordering, all concatenated together. Cloudflare Workers' `crypto.subtle` supports `HMAC`/`SHA-1` natively for `importKey`/`sign`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/twilio/verifySignature.test.ts
import { describe, expect, it } from "vitest";
import { verifyTwilioSignature } from "../../src/twilio/verifySignature";

const AUTH_TOKEN = "test-auth-token";

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

describe("verifyTwilioSignature", () => {
  const url = "https://example.com/webhooks/twilio";
  const params = { CallSid: "CA123", From: "+61400000000", To: "+61200000000", CallStatus: "ringing" };

  it("accepts a correctly signed request", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    expect(await verifyTwilioSignature(url, params, signature, AUTH_TOKEN)).toBe(true);
  });

  it("rejects a tampered param value", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    const tampered = { ...params, From: "+61499999999" };
    expect(await verifyTwilioSignature(url, tampered, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a signature computed with the wrong auth token", async () => {
    const signature = await sign(url, params, "wrong-token");
    expect(await verifyTwilioSignature(url, params, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a signature computed for a different URL", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    expect(await verifyTwilioSignature("https://example.com/other", params, signature, AUTH_TOKEN)).toBe(false);
  });

  it("is independent of the params object's key order", async () => {
    const signature = await sign(url, params, AUTH_TOKEN);
    const reordered = { To: params.To, CallStatus: params.CallStatus, From: params.From, CallSid: params.CallSid };
    expect(await verifyTwilioSignature(url, reordered, signature, AUTH_TOKEN)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- twilio/verifySignature`
Expected: FAIL — `src/twilio/verifySignature.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/twilio/verifySignature.ts
function buildSignedMessage(url: string, params: Record<string, string>): string {
  const sortedConcat = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return url + sortedConcat;
}

export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string,
  authToken: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const message = new TextEncoder().encode(buildSignedMessage(url, params));
    const signature = await crypto.subtle.sign("HMAC", key, message);
    const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return computed === signatureHeader;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- twilio/verifySignature`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/twilio/verifySignature.ts test/twilio/verifySignature.test.ts
git commit -m "feat: add Twilio X-Twilio-Signature HMAC-SHA1 webhook verification"
```

---

### Task 6: TwiML renderer

**Files:**
- Create: `src/twilio/twiml.ts`
- Test: `test/twilio/twiml.test.ts`

**Interfaces:**
- Consumes: `IvrCommand` type from `src/ivr/stateMachine.ts` (Task 7).
- Produces: `renderTwiml(commands: IvrCommand[], opts: { gatherAction: string }): string` — consumed by `CallSession` (Task 8). Renders a full `<Response>...</Response>` TwiML XML document from the state machine's commands, returned directly as the webhook's HTTP response body (Twilio's model has no separate REST command dispatch).

Rendering rules: `ANSWER` → nothing (Twilio has already implicitly answered the call by fetching this TwiML — there is no TwiML verb for "answer"). `SPEAK { text }` → `<Say>text</Say>`. `GATHER { prompt, validDigits }` → `<Gather action="..." method="POST" input="dtmf" numDigits="1" timeout="8"><Say>prompt</Say></Gather>` (the `validDigits` field on the command is intentionally unused here — Twilio's `<Gather>` has no equivalent filter; out-of-range digits are rejected by the state machine's own reducer logic in Task 7, not by the telephony layer). `HANGUP` → `<Hangup/>`. All spoken text is XML-escaped.

- [ ] **Step 1: Write the failing tests**

```ts
// test/twilio/twiml.test.ts
import { describe, expect, it } from "vitest";
import { renderTwiml } from "../../src/twilio/twiml";
import type { IvrCommand } from "../../src/ivr/stateMachine";

const GATHER_ACTION = "https://example.com/webhooks/twilio";

describe("renderTwiml", () => {
  it("renders a SPEAK command as <Say>", () => {
    const commands: IvrCommand[] = [{ type: "SPEAK", text: "Hello there" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello there</Say></Response>');
  });

  it("renders a GATHER command as <Gather> wrapping a <Say>", () => {
    const commands: IvrCommand[] = [{ type: "GATHER", prompt: "Press 1 or 2", validDigits: "12" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Gather action="${GATHER_ACTION}" method="POST" input="dtmf" numDigits="1" timeout="8">` +
        "<Say>Press 1 or 2</Say>" +
        "</Gather>" +
        "</Response>"
    );
  });

  it("renders a HANGUP command as <Hangup/>", () => {
    const commands: IvrCommand[] = [{ type: "HANGUP" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it("renders an ANSWER command as nothing (Twilio auto-answers)", () => {
    const commands: IvrCommand[] = [{ type: "ANSWER" }, { type: "SPEAK", text: "Hi" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi</Say></Response>');
  });

  it("combines multiple commands into one Response, in order", () => {
    const commands: IvrCommand[] = [
      { type: "SPEAK", text: "This call may be recorded." },
      { type: "GATHER", prompt: "Press 1 for sales", validDigits: "1" },
    ];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        "<Say>This call may be recorded.</Say>" +
        `<Gather action="${GATHER_ACTION}" method="POST" input="dtmf" numDigits="1" timeout="8">` +
        "<Say>Press 1 for sales</Say>" +
        "</Gather>" +
        "</Response>"
    );
  });

  it("XML-escapes special characters in spoken text", () => {
    const commands: IvrCommand[] = [{ type: "SPEAK", text: `Bob & Jane's <shop> "special"` }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Bob &amp; Jane&apos;s &lt;shop&gt; &quot;special&quot;</Say></Response>'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- twiml`
Expected: FAIL — `src/twilio/twiml.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/twilio/twiml.ts
import type { IvrCommand } from "../ivr/stateMachine";

export type TwimlOptions = {
  gatherAction: string;
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderCommand(command: IvrCommand, opts: TwimlOptions): string {
  switch (command.type) {
    case "ANSWER":
      return "";
    case "SPEAK":
      return `<Say>${escapeXml(command.text)}</Say>`;
    case "GATHER":
      return (
        `<Gather action="${opts.gatherAction}" method="POST" input="dtmf" numDigits="1" timeout="8">` +
        `<Say>${escapeXml(command.prompt)}</Say>` +
        `</Gather>`
      );
    case "HANGUP":
      return "<Hangup/>";
  }
}

export function renderTwiml(commands: IvrCommand[], opts: TwimlOptions): string {
  const body = commands.map((command) => renderCommand(command, opts)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- twiml`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/twilio/twiml.ts test/twilio/twiml.test.ts
git commit -m "feat: add TwiML renderer for IVR commands"
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

### Task 8: `CallSession` Durable Object — wire state machine to TwiML rendering

**Files:**
- Create: `src/durable-objects/CallSession.ts`
- Modify: `wrangler.jsonc` (add Durable Object binding + migration)
- Test: `test/durable-objects/CallSession.test.ts`

**Interfaces:**
- Consumes: `reduce` from `src/ivr/stateMachine.ts` (Task 7), `renderTwiml` from `src/twilio/twiml.ts` (Task 6), `getBusinessHours`/`isWithinBusinessHours` (Tasks 3–4).
- Produces: `CallSession` class with `fetch(request: Request): Promise<Response>` accepting `POST /events` with an internal JSON body `{ callSid, from, to, digits, webhookUrl }` — consumed by the webhook route (Task 9), which is responsible for translating Twilio's raw form-encoded POST params into this shape. Returns a TwiML XML `Response` (`Content-Type: text/xml`) directly — there is no separate REST command step for this provider. Writes one row to `calls` on the first webhook for a given `callSid` and one row to `call_events` per state transition.

One instance of `CallSession` handles exactly one call (keyed by `callSid` at the caller level via `idFromName`), so its Durable Object storage uses a single fixed key, `"state"` — there is no need to namespace storage keys by call ID inside the instance itself.

Because Twilio's webhook model is synchronous (one TwiML document per request, no "speak finished" callback), the very first webhook for a call must internally apply **both** `CALL_INITIATED` and `GREETING_SPOKEN` before responding, so the disclosure notice and the first menu prompt render together in one `<Response>`. Per this plan's Global Constraints, reaching `ROUTE_STAFF` or `VOICEMAIL` is terminal for this phase: `CallSession` appends an explicit `<Hangup/>` after those states' own commands (and, for `ROUTE_STAFF` specifically — whose reducer commands are empty — a short "connecting you now" `<Say>` first, so a real test call doesn't just go silent).

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
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CallSession"] }]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/durable-objects/CallSession.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { setBusinessHours } from "../../src/db/settings";

const GATHER_ACTION = "https://tcb-voip.example.workers.dev/webhooks/twilio";

function event(callSid: string, overrides: Partial<{ from: string; to: string; digits: string | null }> = {}) {
  return new Request("https://internal/events", {
    method: "POST",
    body: JSON.stringify({
      callSid,
      from: overrides.from ?? "+61400000000",
      to: overrides.to ?? "+61200000000",
      digits: overrides.digits ?? null,
      webhookUrl: GATHER_ACTION,
    }),
  });
}

describe("CallSession", () => {
  beforeEach(async () => {
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

  it("first webhook for a call answers with the disclosure and main menu in one TwiML document", async () => {
    const id = env.CALL_SESSION.idFromName("CA-abc");
    const stub = env.CALL_SESSION.get(id);
    const response = await runInDurableObject(stub, (instance) => instance.fetch(event("CA-abc")));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const xml = await response.text();
    expect(xml).toContain("This call may be recorded");
    expect(xml).toContain("<Gather");
    expect(xml).toContain(`action="${GATHER_ACTION}"`);

    const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind("CA-abc").first();
    expect(row).toMatchObject({ id: "CA-abc", caller_number: "+61400000000", called_number: "+61200000000" });

    const events = await env.DB.prepare("SELECT event_type FROM call_events WHERE call_id = ?").bind("CA-abc").all();
    expect(events.results.length).toBe(2); // CALL_INITIATED then GREETING_SPOKEN
  });

  it("digit 1 routes to ROUTE_STAFF, updates ivr_path, and hangs up (staff ring is a later phase)", async () => {
    const id = env.CALL_SESSION.idFromName("CA-def");
    const stub = env.CALL_SESSION.get(id);
    await runInDurableObject(stub, (instance) => instance.fetch(event("CA-def")));
    const response = await runInDurableObject(stub, (instance) => instance.fetch(event("CA-def", { digits: "1" })));

    const xml = await response.text();
    expect(xml).toContain("<Hangup/>");

    const row = await env.DB.prepare("SELECT ivr_path FROM calls WHERE id = ?").bind("CA-def").first();
    expect(row).toMatchObject({ ivr_path: "new_booking" });
  });

  it("three consecutive gather timeouts fall through to voicemail and hang up", async () => {
    const id = env.CALL_SESSION.idFromName("CA-ghi");
    const stub = env.CALL_SESSION.get(id);
    await runInDurableObject(stub, (instance) => instance.fetch(event("CA-ghi"))); // attempt 1
    await runInDurableObject(stub, (instance) => instance.fetch(event("CA-ghi", { digits: null }))); // -> attempt 2
    await runInDurableObject(stub, (instance) => instance.fetch(event("CA-ghi", { digits: null }))); // -> attempt 3
    const response = await runInDurableObject(stub, (instance) =>
      instance.fetch(event("CA-ghi", { digits: null }))
    ); // -> voicemail

    const xml = await response.text();
    expect(xml).toContain("leave a message");
    expect(xml).toContain("<Hangup/>");

    const row = await env.DB.prepare("SELECT ivr_path FROM calls WHERE id = ?").bind("CA-ghi").first();
    expect(row).toMatchObject({ ivr_path: "voicemail" });
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
import { reduce, type IvrCommand, type IvrEvent, type IvrState } from "../ivr/stateMachine";
import { renderTwiml } from "../twilio/twiml";
import { getBusinessHours } from "../db/settings";
import { isWithinBusinessHours } from "../ivr/businessHours";

type Env = {
  DB: D1Database;
};

type CallEvent = {
  callSid: string;
  from: string;
  to: string;
  digits: string | null;
  webhookUrl: string;
};

export class CallSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const { callSid, from, to, digits, webhookUrl } = (await request.json()) as CallEvent;
    const allCommands: IvrCommand[] = [];
    const stored = await this.ctx.storage.get<IvrState>("state");
    let current: IvrState;

    if (!stored) {
      const schedule = await getBusinessHours(this.env.DB);
      const isAfterHours = !isWithinBusinessHours(schedule, new Date());

      await this.env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(callSid, from, to, Date.now(), isAfterHours ? 1 : 0)
        .run();

      current = await this.applyEvent(callSid, { name: "INCOMING" }, { type: "CALL_INITIATED", isAfterHours }, allCommands);
      current = await this.applyEvent(callSid, current, { type: "GREETING_SPOKEN" }, allCommands);
    } else {
      const nextEvent: IvrEvent = digits ? { type: "DIGIT_RECEIVED", digit: digits } : { type: "GATHER_TIMED_OUT" };
      current = await this.applyEvent(callSid, stored, nextEvent, allCommands);
    }

    if (current.name === "ROUTE_STAFF") {
      allCommands.push({ type: "SPEAK", text: "Thanks, connecting you now." }, { type: "HANGUP" });
    } else if (current.name === "VOICEMAIL") {
      allCommands.push({ type: "HANGUP" });
    }

    await this.ctx.storage.put("state", current);

    const xml = renderTwiml(allCommands, { gatherAction: webhookUrl });
    return new Response(xml, { headers: { "Content-Type": "text/xml" } });
  }

  private async applyEvent(
    callSid: string,
    current: IvrState,
    event: IvrEvent,
    allCommands: IvrCommand[]
  ): Promise<IvrState> {
    const { state: next, commands } = reduce(current, event);
    allCommands.push(...commands);

    await this.env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind(callSid, Date.now(), "state_transition", JSON.stringify({ event, next }))
      .run();

    if (next.name === "ROUTE_STAFF") {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?").bind(next.tag, callSid).run();
    }
    if (next.name === "VOICEMAIL") {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?").bind("voicemail", callSid).run();
    }

    return next;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- CallSession`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add wrangler.jsonc src/durable-objects/CallSession.ts test/durable-objects/CallSession.test.ts
git commit -m "feat: add CallSession Durable Object driving the IVR state machine via TwiML"
```

---

### Task 9: Webhook route — signature verification + routing to `CallSession`

**Files:**
- Modify: `src/worker.ts`
- Modify: `wrangler.jsonc` (add `TWILIO_AUTH_TOKEN` var placeholder, real value set as secret in Task 10)
- Test: `test/worker.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyTwilioSignature` (Task 5), `CallSession` DO binding `env.CALL_SESSION` (Task 8).
- Produces: `POST /webhooks/twilio` route — the only externally-facing entry point Twilio calls, reused as the `action` URL for every `<Gather>` (Twilio always POSTs form-encoded params, never JSON).

- [ ] **Step 1: Write the failing test (append to `test/worker.test.ts`)**

```ts
// test/worker.test.ts (add below the existing health-check test)
import { env } from "cloudflare:test";

describe("POST /webhooks/twilio", () => {
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

  it("rejects a request with an invalid signature", async () => {
    const response = await SELF.fetch("https://example.com/webhooks/twilio", {
      method: "POST",
      headers: { "X-Twilio-Signature": "bad", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1", From: "+61400000000", To: "+61200000000" }).toString(),
    });
    expect(response.status).toBe(401);
  });

  it("accepts a validly signed initial call and forwards it to CallSession", async () => {
    env.TWILIO_AUTH_TOKEN = "test-auth-token";
    const url = "https://example.com/webhooks/twilio";
    const params = { CallSid: "CA-xyz", From: "+61400000002", To: "+61200000000" };
    const signature = await sign(url, params, env.TWILIO_AUTH_TOKEN);

    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { "X-Twilio-Signature": signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const xml = await response.text();
    expect(xml).toContain("<Gather");

    const row = await env.DB.prepare("SELECT id FROM calls WHERE id = ?").bind("CA-xyz").first();
    expect(row).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worker`
Expected: FAIL — `/webhooks/twilio` returns 404 (not found).

- [ ] **Step 3: Update `wrangler.jsonc`'s `vars` block**

```jsonc
"vars": {
  "TWILIO_AUTH_TOKEN": ""
}
```

- [ ] **Step 4: Write the implementation**

```ts
// src/worker.ts
import { verifyTwilioSignature } from "./twilio/verifySignature";
export { CallSession } from "./durable-objects/CallSession";

type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  TWILIO_AUTH_TOKEN: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/webhooks/twilio" && request.method === "POST") {
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

      const id = env.CALL_SESSION.idFromName(params.CallSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callSid: params.CallSid,
          from: params.From,
          to: params.To,
          digits: params.Digits ?? null,
          webhookUrl: request.url,
        }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
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
git commit -m "feat: add /webhooks/twilio route with signature verification and DO routing"
```

---

### Task 10: Twilio account setup + real end-to-end test call

This task is operational, not code — it connects the system built in Tasks 1–9 to a real phone number.

- [ ] **Step 1: Create a Twilio account and provision for Australian numbers**

At twilio.com, sign up, and provide the identity/regulatory information Twilio requires for Australian local numbers (your name and an Australian address — a PO Box is not accepted where a local address is required; Twilio may prompt for further regulatory-bundle details depending on account type).

- [ ] **Step 2: Buy an Australian number**

In the Twilio Console: Develop → Phone Numbers → Manage → Buy a Number. Set the country dropdown to Australia, ensure **Voice** capability is checked, and purchase a local (+61) number.

- [ ] **Step 3: Point the number's voice webhook at the deployed Worker**

In the Console, open the purchased number's configuration page. Under **Voice Configuration**, set "A call comes in" to **Webhook**, the URL to `https://<your-worker-subdomain>.workers.dev/webhooks/twilio`, and the method to **HTTP POST**. Save.

- [ ] **Step 4: Copy your Twilio Auth Token**

Console → Account → API keys & tokens (or the Account Info panel on the Console home page) → copy the **Auth Token** (not the Account SID — this phase's code only needs the Auth Token, for webhook signature verification).

- [ ] **Step 5: Set the real secret on the deployed Worker**

Run: `npx wrangler secret put TWILIO_AUTH_TOKEN` (paste the Auth Token when prompted)

- [ ] **Step 6: Apply migrations to the remote D1 database and deploy**

Run: `npx wrangler d1 migrations apply tcb-voip-db --remote`
Run: `npm run deploy`
Expected: deploy succeeds, prints the `*.workers.dev` URL used in Step 3.

- [ ] **Step 7: Place a real test call**

Call the new Twilio AU number from any phone. Expected: you hear the recording-disclosure notice, then the main menu; pressing `1`, `2`, `3`, or `0` should each get a brief "Thanks, connecting you now" followed by the call ending (no real staff routing yet — that's a later plan); waiting out three timeouts or entering an invalid digit three times should play the voicemail prompt and then end the call.

- [ ] **Step 8: Verify the D1 trail for that call**

Run: `npx wrangler d1 execute tcb-voip-db --remote --command "SELECT * FROM calls ORDER BY started_at DESC LIMIT 1"`
Run: `npx wrangler d1 execute tcb-voip-db --remote --command "SELECT event_type, detail FROM call_events WHERE call_id = '<id from previous query>' ORDER BY ts"`
Expected: the `calls` row shows the correct `caller_number`/`ivr_path` (the `id` column will be the Twilio `CallSid`, e.g. `CAxxxxxxxx...`), and `call_events` shows the exact sequence of state transitions matching what you pressed on the phone.

- [ ] **Step 9: Test the after-hours branch**

Run: `npx wrangler d1 execute tcb-voip-db --remote --command "INSERT INTO settings (key, value) VALUES ('business_hours', '{\"mon\":null,\"tue\":null,\"wed\":null,\"thu\":null,\"fri\":null,\"sat\":null,\"sun\":null}') ON CONFLICT(key) DO UPDATE SET value = excluded.value"`

This marks every day closed. Call the number again — expect the after-hours notice and the "press 1 for emergency" menu instead of the main menu. Afterward, restore real business hours with the equivalent `INSERT ... ON CONFLICT` using your actual schedule.

- [ ] **Step 10: Watch for signature-verification edge cases against real traffic**

Twilio's own docs flag that hand-rolled `X-Twilio-Signature` checks commonly break on proxy/URL-rewriting edge cases that synthetic tests can't catch. If Step 7's test call gets a 401 in the Worker's logs (`npx wrangler tail`) despite a correct Auth Token, compare the exact `request.url` the Worker sees against the webhook URL configured in Step 3 — a scheme/host mismatch here is the most common real-world cause.

---

## Self-Review Notes

- **Spec coverage:** This plan implements Build Phases 0–2 of the design spec (`docs/superpowers/specs/2026-08-07-tcb-voip-design.md`) in full — foundations, D1 schema (the subset needed so far), Twilio webhook signature verification, TwiML rendering of answer/speak/gather/hangup, webhook routing, and the complete IVR state machine including after-hours branching and retry/voicemail fallback. Phases 3–8 (staff ring/AMD/bridge, recording, transcription, listen-in, dashboard, ServiceM8, cutover) are intentionally out of scope — each becomes its own follow-up plan once this one is verified working end-to-end with a real call.
- **Type consistency:** `IvrState`/`IvrEvent`/`IvrCommand` names and shapes are defined once in Task 7 and reused verbatim in Task 6 (renderer), Task 8 (Durable Object), and Task 9 (tests). `BusinessHoursSchedule` is defined once in Task 3 and reused in Tasks 4 and 8.
- **No placeholders:** every step includes complete, runnable code; the one operational task (Task 10) is explicitly non-code and is scoped to portal/CLI actions with exact commands and expected results, not vague instructions.
- **Provider-pivot consistency check:** Tasks 1–4 and 7 were already implemented and reviewed under the original (correct, provider-agnostic) design before the Telnyx→Twilio pivot and needed no changes. Tasks 5, 6, 8, 9, 10 were rewritten in place for Twilio and re-checked against each other for interface consistency (`renderTwiml`'s signature matches what `CallSession` calls it with; the internal `CallEvent` JSON shape produced by Task 9's worker route matches exactly what Task 8's `CallSession.fetch` destructures).

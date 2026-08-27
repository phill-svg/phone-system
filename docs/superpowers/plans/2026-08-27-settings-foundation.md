# Settings Foundation + Notification Gating — Implementation Plan (Plan 1 of Workstream B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a real per-user settings store (server-backed, survives reinstall), expose it
over an authed API and a mobile hook, and make the SMS notification toggle actually gate SMS pushes.

**Architecture:** A new `user_settings` D1 table keyed by `(email, key)` holds per-user preferences
as JSON values. A `db/userSettings.ts` module merges stored keys over typed defaults; `api/userSettings.ts`
serves `GET/PUT /api/settings/me` (Bearer auth, no admin gate — each user owns their row). Push
recipient selection gains `getPushTokensForType`, which drops tokens whose owner disabled that push
type. On mobile, a `UserSettingsProvider` fetches settings on sign-in, caches to SecureStore for
instant paint, and writes through on change; the Settings screen's notification rows bind to it.

**Tech Stack:** Cloudflare Workers + D1 (SQLite), TypeScript, vitest (`@cloudflare/vitest-pool-workers`),
Expo React Native (SDK 54), `expo-secure-store`, Expo Push.

## Global Constraints

- Worker deploy branch is `master`; the deployed worker is pushed from local and **diverges** from the
  repo — do **not** run `wrangler deploy` as part of this plan. Ship mobile changes via `eas update
  --branch preview` and OTA_BUILD bumps.
- Verify typecheck with `npx tsc --noEmit; echo $?` (never pipe through `head` — it swallows the exit code).
- Server tests: `npx vitest run` from repo root. Mobile typecheck: `cd mobile && npx tsc --noEmit`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and must NOT
  include a Claude-Session URL trailer.
- Auth identity is `staff_users.email` (lowercased). `requireStaffUser` returns `StaffUser =
  { email: string; role: "admin" | "staff" }`.
- Settings values are JSON-encoded scalars in the `value` column (`JSON.stringify(false)` → `'false'`).
- Every OTA push bumps `OTA_BUILD` in `mobile/src/app/(tabs)/settings.tsx` (currently `"19"`).

## File Structure

- Create `migrations/0022_user_settings.sql` — the per-user settings table.
- Create `src/db/userSettings.ts` — typed `UserSettings`, `DEFAULT_USER_SETTINGS`, `NOTIF_KEYS`,
  `getUserSettings`, `setUserSettings`.
- Create `src/api/userSettings.ts` — `handleGetUserSettings`, `handlePutUserSettings`.
- Modify `src/worker.ts` — route `/api/settings/me`.
- Modify `src/db/pushTokens.ts` — add `getPushTokensForType`.
- Modify `src/api/push.ts` — gate `notifyInboundSms` on `notif_sms`.
- Create `test/db/userSettings.test.ts`, `test/db/pushTokensForType.test.ts`,
  `test/api/userSettings.test.ts`.
- Create `mobile/src/lib/userSettings.tsx` — provider + `useUserSettings` hook.
- Modify `mobile/src/lib/api.ts` — `getUserSettings`, `updateUserSettings`, `UserSettings` type.
- Modify `mobile/src/app/_layout.tsx` — mount `UserSettingsProvider`.
- Modify `mobile/src/app/(tabs)/settings.tsx` — bind notification rows to the hook; add SMS row.

---

### Task 1: `user_settings` table + DB module

**Files:**
- Create: `migrations/0022_user_settings.sql`
- Create: `src/db/userSettings.ts`
- Test: `test/db/userSettings.test.ts`

**Interfaces:**
- Produces:
  - `type UserSettings = { notif_incoming: boolean; notif_missed: boolean; notif_voicemail: boolean; notif_sms: boolean; ring_my_mobile: boolean; mobile_number: string }`
  - `const DEFAULT_USER_SETTINGS: UserSettings`
  - `const NOTIF_KEYS = ["notif_incoming", "notif_missed", "notif_voicemail", "notif_sms"] as const`
  - `getUserSettings(db: D1Database, email: string): Promise<UserSettings>`
  - `setUserSettings(db: D1Database, email: string, partial: Partial<UserSettings>): Promise<UserSettings>`

- [ ] **Step 1: Write the migration**

Create `migrations/0022_user_settings.sql`:

```sql
-- Per-user preferences (notifications, ring-my-mobile). Keyed by staff email so they survive
-- reinstall / new device. Values are JSON-encoded scalars. Business-wide config stays in `settings`.
CREATE TABLE IF NOT EXISTS user_settings (
  email      TEXT NOT NULL REFERENCES staff_users(email),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (email, key)
);
```

- [ ] **Step 2: Write the failing test**

Create `test/db/userSettings.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getUserSettings, setUserSettings, DEFAULT_USER_SETTINGS } from "../../src/db/userSettings";

const EMAIL = "phill@tcbpestcontrolcanberra.com.au";

describe("userSettings db", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
  });

  it("returns defaults for a user with no stored rows", async () => {
    expect(await getUserSettings(env.DB, EMAIL)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("setUserSettings persists a partial and merges over defaults", async () => {
    const merged = await setUserSettings(env.DB, EMAIL, { notif_sms: false, mobile_number: "0400111222" });
    expect(merged.notif_sms).toBe(false);
    expect(merged.mobile_number).toBe("0400111222");
    expect(merged.notif_incoming).toBe(true); // untouched default
    expect(await getUserSettings(env.DB, EMAIL)).toEqual(merged);
  });

  it("ignores unknown keys", async () => {
    await setUserSettings(env.DB, EMAIL, { bogus: true } as never);
    expect(await getUserSettings(env.DB, EMAIL)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("keeps different users' settings separate", async () => {
    await setUserSettings(env.DB, EMAIL, { notif_sms: false });
    expect((await getUserSettings(env.DB, "other@tcb.example")).notif_sms).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/db/userSettings.test.ts`
Expected: FAIL — cannot find module `../../src/db/userSettings`.

- [ ] **Step 4: Write the DB module**

Create `src/db/userSettings.ts`:

```typescript
// Per-user preferences, merged over typed defaults. Stored one row per (email, key) with the value
// JSON-encoded, so new keys are additive and reads always return a complete, typed object.

export type UserSettings = {
  notif_incoming: boolean;
  notif_missed: boolean;
  notif_voicemail: boolean;
  notif_sms: boolean;
  ring_my_mobile: boolean;
  mobile_number: string;
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  notif_incoming: true,
  notif_missed: true,
  notif_voicemail: true,
  notif_sms: true,
  ring_my_mobile: false,
  mobile_number: "",
};

export const NOTIF_KEYS = ["notif_incoming", "notif_missed", "notif_voicemail", "notif_sms"] as const;
export type NotifKey = (typeof NOTIF_KEYS)[number];

// Validate a stored/incoming value against the default's type. Wrong-typed values are dropped so a
// corrupt row can never widen the type.
function coerce<K extends keyof UserSettings>(key: K, value: unknown): UserSettings[K] | undefined {
  const expected = typeof DEFAULT_USER_SETTINGS[key];
  return typeof value === expected ? (value as UserSettings[K]) : undefined;
}

const KNOWN_KEYS = Object.keys(DEFAULT_USER_SETTINGS) as (keyof UserSettings)[];

export async function getUserSettings(db: D1Database, email: string): Promise<UserSettings> {
  const rows = await db
    .prepare("SELECT key, value FROM user_settings WHERE email = ?")
    .bind(email.toLowerCase())
    .all<{ key: string; value: string }>();
  const result: UserSettings = { ...DEFAULT_USER_SETTINGS };
  for (const row of rows.results) {
    if (!KNOWN_KEYS.includes(row.key as keyof UserSettings)) continue;
    const key = row.key as keyof UserSettings;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const value = coerce(key, parsed);
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export async function setUserSettings(
  db: D1Database,
  email: string,
  partial: Partial<UserSettings>
): Promise<UserSettings> {
  const now = Date.now();
  const lower = email.toLowerCase();
  const stmts: D1PreparedStatement[] = [];
  for (const key of KNOWN_KEYS) {
    if (!(key in partial)) continue;
    const value = coerce(key, partial[key]);
    if (value === undefined) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO user_settings (email, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(email, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(lower, key, JSON.stringify(value), now)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return getUserSettings(db, lower);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/db/userSettings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit; echo $?` (expect `0`).

```bash
git add migrations/0022_user_settings.sql src/db/userSettings.ts test/db/userSettings.test.ts
git commit -m "feat(settings): per-user user_settings store (table + typed merge)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `/api/settings/me` endpoint

**Files:**
- Create: `src/api/userSettings.ts`
- Modify: `src/worker.ts` (add route in the `/api/` block)
- Test: `test/api/userSettings.test.ts`

**Interfaces:**
- Consumes: `getUserSettings`, `setUserSettings` (Task 1); `StaffUser`; `jsonResponse`.
- Produces:
  - `handleGetUserSettings(db: D1Database, staff: StaffUser): Promise<Response>`
  - `handlePutUserSettings(request: Request, db: D1Database, staff: StaffUser): Promise<Response>`

- [ ] **Step 1: Write the failing test**

Create `test/api/userSettings.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetUserSettings, handlePutUserSettings } from "../../src/api/userSettings";
import { DEFAULT_USER_SETTINGS } from "../../src/db/userSettings";

const staff = { email: "phill@tcbpestcontrolcanberra.com.au", role: "staff" as const };

function put(body: unknown): Request {
  return new Request("https://x/api/settings/me", { method: "PUT", body: JSON.stringify(body) });
}

describe("/api/settings/me", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
  });

  it("GET returns defaults for a fresh user", async () => {
    const res = await handleGetUserSettings(env.DB, staff);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("PUT persists a partial and returns the merged object", async () => {
    const res = await handlePutUserSettings(put({ notif_sms: false }), env.DB, staff);
    expect(res.status).toBe(200);
    expect((await res.json() as typeof DEFAULT_USER_SETTINGS).notif_sms).toBe(false);
    const after = await handleGetUserSettings(env.DB, staff);
    expect((await after.json() as typeof DEFAULT_USER_SETTINGS).notif_sms).toBe(false);
  });

  it("PUT rejects a non-object body with 400", async () => {
    const res = await handlePutUserSettings(put("nope"), env.DB, staff);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api/userSettings.test.ts`
Expected: FAIL — cannot find module `../../src/api/userSettings`.

- [ ] **Step 3: Write the handlers**

Create `src/api/userSettings.ts`:

```typescript
import { jsonResponse } from "./respond";
import { getUserSettings, setUserSettings, type UserSettings } from "../db/userSettings";
import type { StaffUser } from "../access/requireStaffUser";

export async function handleGetUserSettings(db: D1Database, staff: StaffUser): Promise<Response> {
  return jsonResponse(await getUserSettings(db, staff.email));
}

export async function handlePutUserSettings(
  request: Request,
  db: D1Database,
  staff: StaffUser
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response("invalid request body", { status: 400 });
  }
  // setUserSettings ignores unknown/wrong-typed keys, so passing the raw object is safe.
  const merged = await setUserSettings(db, staff.email, body as Partial<UserSettings>);
  return jsonResponse(merged);
}
```

- [ ] **Step 4: Wire the route in `src/worker.ts`**

Add the import near the other api imports (e.g. after the `handleGet…settings` import line ~17):

```typescript
import { handleGetUserSettings, handlePutUserSettings } from "./api/userSettings";
```

Inside the `if (url.pathname.startsWith("/api/")) { … }` block, after the existing
`/api/settings/call-blocklist` handler, add (per-user — NOT admin-gated):

```typescript
      if (url.pathname === "/api/settings/me") {
        return request.method === "PUT"
          ? handlePutUserSettings(request, env.DB, staff)
          : handleGetUserSettings(env.DB, staff);
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/api/userSettings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit; echo $?` (expect `0`).

```bash
git add src/api/userSettings.ts src/worker.ts test/api/userSettings.test.ts
git commit -m "feat(settings): GET/PUT /api/settings/me for per-user preferences

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Gate SMS notifications on `notif_sms`

**Files:**
- Modify: `src/db/pushTokens.ts` (add `getPushTokensForType`)
- Modify: `src/api/push.ts` (`notifyInboundSms` uses the gated selector)
- Test: `test/db/pushTokensForType.test.ts`

**Interfaces:**
- Consumes: `NotifKey` (Task 1).
- Produces: `getPushTokensForType(db: D1Database, key: NotifKey): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

Create `test/db/pushTokensForType.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getPushTokensForType } from "../../src/db/pushTokens";
import { setUserSettings } from "../../src/db/userSettings";

async function addToken(token: string, email: string | null) {
  await env.DB.prepare(
    "INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)"
  ).bind(token, email).run();
}

describe("getPushTokensForType", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await env.DB.prepare("DELETE FROM user_settings").run();
  });

  it("includes tokens whose owner has the type enabled (default) and null-owner tokens", async () => {
    await addToken("t-default", "a@tcb.example");
    await addToken("t-null", null);
    expect((await getPushTokensForType(env.DB, "notif_sms")).sort()).toEqual(["t-default", "t-null"]);
  });

  it("excludes tokens whose owner disabled the type", async () => {
    await addToken("t-on", "on@tcb.example");
    await addToken("t-off", "off@tcb.example");
    await setUserSettings(env.DB, "off@tcb.example", { notif_sms: false });
    expect(await getPushTokensForType(env.DB, "notif_sms")).toEqual(["t-on"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/db/pushTokensForType.test.ts`
Expected: FAIL — `getPushTokensForType` is not exported.

- [ ] **Step 3: Add `getPushTokensForType` to `src/db/pushTokens.ts`**

Add the import at the top of the file:

```typescript
import type { NotifKey } from "./userSettings";
```

Append the function:

```typescript
// Tokens to notify for a given push type. A token is included when its owner has NOT disabled that
// type (default is on) — and tokens with no known owner are always included. `value = 'false'` is the
// JSON encoding a disabled boolean is stored as (see userSettings).
export async function getPushTokensForType(db: D1Database, key: NotifKey): Promise<string[]> {
  const tokens = await db
    .prepare("SELECT token, staff_email FROM push_tokens")
    .all<{ token: string; staff_email: string | null }>();
  const disabled = await db
    .prepare("SELECT email FROM user_settings WHERE key = ? AND value = 'false'")
    .bind(key)
    .all<{ email: string }>();
  const disabledSet = new Set(disabled.results.map((r) => r.email));
  return tokens.results
    .filter((r) => !r.staff_email || !disabledSet.has(r.staff_email))
    .map((r) => r.token);
}
```

- [ ] **Step 4: Gate `notifyInboundSms` in `src/api/push.ts`**

Change the import line:

```typescript
import { upsertPushToken, listPushTokens, deletePushTokens, getPushTokensForType } from "../db/pushTokens";
```

In `notifyInboundSms`, replace the first line of the body:

```typescript
  const tokens = await listPushTokens(db);
```

with:

```typescript
  const tokens = await getPushTokensForType(db, "notif_sms");
```

(`listPushTokens` stays exported — other callers may use it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/db/pushTokensForType.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npx tsc --noEmit; echo $?` (expect `0`).
Run: `npx vitest run` (expect all green — confirms no regression in existing push/SMS tests).

```bash
git add src/db/pushTokens.ts src/api/push.ts test/db/pushTokensForType.test.ts
git commit -m "feat(notifications): gate inbound-SMS push on the per-user notif_sms toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mobile settings API helpers + provider/hook

**Files:**
- Modify: `mobile/src/lib/api.ts` (types + `getUserSettings`, `updateUserSettings`)
- Create: `mobile/src/lib/userSettings.tsx` (provider + hook)
- Modify: `mobile/src/app/_layout.tsx` (mount the provider)

**Interfaces:**
- Consumes: `apiFetch`, `useAuth` (existing).
- Produces:
  - `type UserSettings` (mobile mirror of the server shape)
  - `getUserSettings(): Promise<UserSettings>` / `updateUserSettings(partial: Partial<UserSettings>): Promise<UserSettings>`
  - `UserSettingsProvider` React component
  - `useUserSettings(): { settings: UserSettings; update: (p: Partial<UserSettings>) => void; loaded: boolean }`

- [ ] **Step 1: Add API helpers + type to `mobile/src/lib/api.ts`**

Append:

```typescript
// ---- Per-user settings ----
export type UserSettings = {
  notif_incoming: boolean;
  notif_missed: boolean;
  notif_voicemail: boolean;
  notif_sms: boolean;
  ring_my_mobile: boolean;
  mobile_number: string;
};

export async function getUserSettings(): Promise<UserSettings> {
  return apiFetch<UserSettings>("/api/settings/me");
}

export async function updateUserSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
  return apiFetch<UserSettings>("/api/settings/me", { method: "PUT", body: JSON.stringify(partial) });
}
```

- [ ] **Step 2: Write the provider + hook**

Create `mobile/src/lib/userSettings.tsx`:

```tsx
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { getUserSettings, updateUserSettings, type UserSettings } from "./api";
import { useAuth } from "./auth";

const DEFAULTS: UserSettings = {
  notif_incoming: true,
  notif_missed: true,
  notif_voicemail: true,
  notif_sms: true,
  ring_my_mobile: false,
  mobile_number: "",
};

const CACHE_KEY = "user_settings_cache";

type Ctx = { settings: UserSettings; update: (p: Partial<UserSettings>) => void; loaded: boolean };
const UserSettingsContext = createContext<Ctx>({ settings: DEFAULTS, update: () => {}, loaded: false });

export function UserSettingsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Paint from cache immediately, then refresh from the server once signed in.
  useEffect(() => {
    SecureStore.getItemAsync(CACHE_KEY)
      .then((raw) => {
        if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<UserSettings>) });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    getUserSettings()
      .then((s) => {
        setSettings(s);
        SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(s)).catch(() => {});
      })
      .catch(() => {}); // keep cached values on network failure
  }, [user]);

  // Optimistic update: reflect locally + cache now, write through to the server, reconcile on reply.
  const update = (partial: Partial<UserSettings>) => {
    const next = { ...settingsRef.current, ...partial };
    setSettings(next);
    SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(next)).catch(() => {});
    updateUserSettings(partial)
      .then((server) => {
        setSettings(server);
        SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(server)).catch(() => {});
      })
      .catch(() => {}); // leave the optimistic value; next launch re-syncs from server
  };

  return (
    <UserSettingsContext.Provider value={{ settings, update, loaded }}>
      {children}
    </UserSettingsContext.Provider>
  );
}

export function useUserSettings(): Ctx {
  return useContext(UserSettingsContext);
}
```

- [ ] **Step 3: Mount the provider in `mobile/src/app/_layout.tsx`**

Add the import alongside the other lib imports:

```tsx
import { UserSettingsProvider } from "../lib/userSettings";
```

Wrap the existing app tree with `<UserSettingsProvider>` **inside** the existing `AuthProvider` (it
depends on `useAuth`). For example, if the tree is `<AuthProvider>{children}</AuthProvider>`, make it
`<AuthProvider><UserSettingsProvider>{children}</UserSettingsProvider></AuthProvider>`.

- [ ] **Step 4: Typecheck**

Run: `cd mobile && npx tsc --noEmit; echo $?` (expect `0`).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/lib/api.ts mobile/src/lib/userSettings.tsx mobile/src/app/_layout.tsx
git commit -m "feat(mobile): user-settings provider + API helpers (server-backed, cached)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Bind Settings notification rows to the hook (+ SMS row)

**Files:**
- Modify: `mobile/src/app/(tabs)/settings.tsx`

**Interfaces:**
- Consumes: `useUserSettings` (Task 4).

- [ ] **Step 1: Import the hook**

Add near the other lib imports in `settings.tsx`:

```tsx
import { useUserSettings } from "../../lib/userSettings";
```

- [ ] **Step 2: Replace the local notification prefs with server-backed ones**

Inside `SettingsScreen`, add after the existing hooks:

```tsx
  const { settings, update } = useUserSettings();
```

Remove these three lines (the notification prefs move to the server-backed hook):

```tsx
  const [nIncoming, setNIncoming] = usePersistedBool("pref_notify_incoming", true);
  const [nMissed, setNMissed] = usePersistedBool("pref_notify_missed", true);
  const [nVoicemail, setNVoicemail] = usePersistedBool("pref_notify_voicemail", true);
```

(Leave the other `usePersistedBool` calls — callWaiting, autoAnswer, recording, bluetooth — untouched;
they are device-local and handled in Plan 2.)

- [ ] **Step 3: Rewrite the Notifications group**

Replace the existing `<Group title="Notifications">…</Group>` block with:

```tsx
        <Group title="Notifications" footer="Choose which alerts this account receives.">
          <Row icon="phone.fill" iconColor="#34C759" label="Incoming Calls"
            toggle={settings.notif_incoming} onToggle={(v) => update({ notif_incoming: v })} />
          <Row icon="phone.arrow.down.left.fill" iconColor={t.colors.accent} label="Missed Calls"
            toggle={settings.notif_missed} onToggle={(v) => update({ notif_missed: v })} />
          <Row icon="waveform" iconColor="#0A84FF" label="Voicemail"
            toggle={settings.notif_voicemail} onToggle={(v) => update({ notif_voicemail: v })} />
          <Row icon="message.fill" iconColor="#30D158" label="SMS Messages"
            toggle={settings.notif_sms} onToggle={(v) => update({ notif_sms: v })} />
        </Group>
```

- [ ] **Step 4: Bump OTA build**

In `settings.tsx`, change:

```tsx
const OTA_BUILD = "19";
```

to:

```tsx
const OTA_BUILD = "20";
```

- [ ] **Step 5: Typecheck**

Run: `cd mobile && npx tsc --noEmit; echo $?` (expect `0`).

- [ ] **Step 6: Commit**

```bash
git add "mobile/src/app/(tabs)/settings.tsx"
git commit -m "feat(mobile): notification toggles are server-backed; add SMS Messages row (OTA #20)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification (on the dev build)

**Files:** none (verification only).

- [ ] **Step 1: Apply the migration to the live D1**

The `user_settings` table must exist in production before the API works. Apply migration 0022 to the
remote D1 (the DB `wrangler.jsonc` binds as `DB`):

Run: `npx wrangler d1 migrations apply <DB_NAME> --remote`
(Find `<DB_NAME>` in `wrangler.jsonc` under `d1_databases[].database_name`.)
Expected: reports `0022_user_settings.sql` applied.

- [ ] **Step 2: Smoke-test the API against tcbvoip.app**

With a valid session token in `$TOKEN`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://tcbvoip.app/api/settings/me
```

Expected: JSON with all six keys at their defaults.

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"notif_sms":false}' https://tcbvoip.app/api/settings/me
```

Expected: same JSON with `"notif_sms": false`; a follow-up GET still shows `false`.

- [ ] **Step 3: Publish the OTA update**

Run: `cd mobile && npx eas update --branch preview --message "#20 server-backed notification settings + SMS row"`
Expected: `Published!` to branch `preview`, runtime `1.0.0`.

- [ ] **Step 4: Verify on the phone**

- Open the app → Settings → About shows `#20`.
- Toggle **SMS Messages** off. Send a text to `+61485034869` → **no** push arrives on this device.
- Toggle it back on → sending a text produces a push again.
- Force-quit and reopen → the toggle state persisted (came back from the server).

- [ ] **Step 5: Final full-suite check**

Run: `npx vitest run` (repo root) and `npx tsc --noEmit; echo $?` — both green/`0`.

---

## Self-Review

- **Spec coverage (Plan 1 slice):** per-user store ✓ (Task 1), `/api/settings/me` ✓ (Task 2),
  notification gating infra + SMS enforcement ✓ (Task 3), mobile hook with SecureStore cache +
  optimistic write-through ✓ (Task 4), Settings rows server-backed + SMS row ✓ (Task 5),
  on-device verification ✓ (Task 6). Deferred to Plan 2 (documented): Audio Routing, Bluetooth,
  Auto-Answer, Call Waiting, Call Recording (business-wide), Call Forwarding (ring-my-mobile), and the
  missed-call/voicemail push *sends* those toggles will gate.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `UserSettings`, `DEFAULT_USER_SETTINGS`, `NOTIF_KEYS`/`NotifKey`,
  `getUserSettings`/`setUserSettings`, `getPushTokensForType`, `handleGetUserSettings`/
  `handlePutUserSettings`, and the mobile `getUserSettings`/`updateUserSettings`/`useUserSettings`
  names are used consistently across tasks. The mobile `UserSettings` mirrors the server shape exactly.

## Follow-on: Plan 2 (Workstream B, call behaviors)

To be written after Plan 1 lands: Audio Routing + Bluetooth (Twilio `getAudioDevices`/`AudioDevice.select`),
Auto-Answer + Call Waiting (invite-handler logic in `voice.ts`), Call Recording (business-wide toggle
honored in `queueTwiml.ts` + `/twiml/voice-app`, admin-gated), Call Forwarding / ring-my-mobile
(`resolveRingTargets` adds a `number:{mobile}` leg, gated by opening hours + availability), and the
missed-call/voicemail push sends (then gated via `getPushTokensForType`).

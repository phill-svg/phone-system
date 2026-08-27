# Call Recording + Missed/Voicemail Notifications — Implementation Plan (Plan 3 of Workstream B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the last two server-enforced Settings behaviors real: a **business-wide Call Recording** toggle (admin-editable, staff read-only) that actually turns call recording on/off, and **missed-call + voicemail push notifications** that the server sends and that honor the per-user notification toggles from Plan 1.

**Architecture:** Recording lives on one TwiML renderer — `renderDialAgentIntoConference` (the leg that creates+records the conference); its 3 callers read a new `recording_enabled` business setting (global `settings` table) and pass it, omitting the `record`/`recordingStatusCallback` attributes when off. Missed/voicemail pushes reuse Plan 1's typed gating: new `notifyMissedCall`/`notifyVoicemail` send via `getPushTokensForType("notif_missed"/"notif_voicemail")` + `sendExpoPush`, called from the DO at the no-answer and voicemail-left points.

**Tech Stack:** Cloudflare Workers Durable Objects + D1, TypeScript, vitest (`@cloudflare/vitest-pool-workers`), Expo React Native (SDK 54), Expo Push.

## Global Constraints

- Worker deploy branch is `master`; the deployed worker diverges from the repo — do **not** run `wrangler deploy`. Ship mobile via `eas update --branch preview` + `OTA_BUILD` bump.
- Typecheck: `npx tsc --noEmit; echo $?` (never pipe through `head`). Mobile: `cd mobile && npx tsc --noEmit`.
- Server tests: `npx vitest run` from repo root (wrangler must be logged in). Full suite is currently 455/455 — keep it green; each server task re-runs it.
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; NO Claude-Session URL trailer.
- **Recording defaults ON** (matches current always-on behavior). Only `role === "admin"` may change it; staff get read-only.
- Notification gating reuses Plan 1: `getPushTokensForType(db, key)` in `src/db/pushTokens.ts` (a token is included unless its owner disabled that type). Keys: `notif_missed`, `notif_voicemail`.
- Push send helper: `sendExpoPush(tokens, { title, body, data })` in `src/push/expoPush.ts`; prune invalid tokens via `deletePushTokens`. Contact-name lookup: `findContactByPhone(db, number)` in `src/db/contacts.ts` (see `notifyInboundSms` in `src/api/push.ts` for the exact pattern).

## Decisions (made explicit)

- **Missed-call push** fires when an inbound call is not answered by any staff — at the DO's no-answer / caller-hung-up point (`CallSession.ts` ~line 566, where it logs `no_answer`/`caller_hung_up`). **Voicemail push** fires when a voicemail is recorded (`CallSession.ts` ~line 159, `voicemail_left`). An unanswered call that then leaves a voicemail therefore produces BOTH a missed-call and a voicemail notification — this matches how phones normally behave ("missed call" + "1 voicemail" are distinct alerts). If the user later wants missed suppressed when a voicemail follows, that's a follow-up.
- **"Incoming call" notifications** are NOT a server-sent Expo push (an incoming call arrives via the native Twilio VoIP push / softphone ring), so `notif_incoming` is not wired to a server send here; the toggle persists (Plan 1) but gates nothing server-side. Documented, not implemented.

## File Structure

- Modify `src/db/settings.ts` — `getRecordingEnabled`/`setRecordingEnabled` (default true).
- Modify `src/api/settings.ts` — `handleGetRecording`/`handlePutRecording` (admin-gated PUT).
- Modify `src/worker.ts` — route `/api/settings/recording`; add it to the `adminOnlyRead` GET gate; pass `record` to the 3 `renderDialAgentIntoConference` callers.
- Modify `src/twilio/conferenceTwiml.ts` — `renderDialAgentIntoConference` takes `record?: boolean` (default true).
- Modify `src/durable-objects/CallSession.ts` — pass `record` at the one DO caller; call `notifyMissedCall`/`notifyVoicemail`.
- Modify `src/api/push.ts` — add `notifyMissedCall`, `notifyVoicemail`.
- Modify `mobile/src/app/(tabs)/settings.tsx` — Call Recording row bound to the business setting (admin edit), OTA bump; add `getRecordingSetting`/`setRecordingSetting` to `mobile/src/lib/api.ts`.
- Tests: `test/db/settings.test.ts`, `test/api/settings.test.ts` (extend), `test/twilio/conferenceTwiml.test.ts` (extend), `test/api/push.test.ts` (create/extend), `test/durable-objects/CallSession.test.ts` (extend).

---

### Task 1: `recording_enabled` business setting + admin API

**Files:**
- Modify: `src/db/settings.ts`, `src/api/settings.ts`, `src/worker.ts`
- Test: `test/db/settings.test.ts`, `test/api/settings.test.ts`

**Interfaces:**
- Produces:
  - `getRecordingEnabled(db: D1Database): Promise<boolean>` (default `true` when unset)
  - `setRecordingEnabled(db: D1Database, enabled: boolean): Promise<void>`
  - `handleGetRecording(db): Promise<Response>` → `{ recording_enabled: boolean }`
  - `handlePutRecording(request, db, staff): Promise<Response>` (admin-only; body `{ recording_enabled: boolean }`)
  - Route `GET/PUT /api/settings/recording` (GET admin-gated like other settings reads).

- [ ] **Step 1: Write the failing DB test**

Add to `test/db/settings.test.ts`:

```typescript
import { getRecordingEnabled, setRecordingEnabled } from "../../src/db/settings";
// ... within the existing describe or a new one:
describe("recording setting", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM settings WHERE key = 'recording_enabled'").run(); });
  it("defaults to true when unset", async () => {
    expect(await getRecordingEnabled(env.DB)).toBe(true);
  });
  it("round-trips false and true", async () => {
    await setRecordingEnabled(env.DB, false);
    expect(await getRecordingEnabled(env.DB)).toBe(false);
    await setRecordingEnabled(env.DB, true);
    expect(await getRecordingEnabled(env.DB)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/db/settings.test.ts`
Expected: FAIL — `getRecordingEnabled` not exported.

- [ ] **Step 3: Implement in `src/db/settings.ts`** (mirror the existing `getCallBlocklist`/`setCallBlocklist` pattern)

```typescript
const RECORDING_ENABLED_KEY = "recording_enabled";

export async function getRecordingEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(RECORDING_ENABLED_KEY).first<{ value: string }>();
  if (!row) return true; // default ON
  return JSON.parse(row.value) === true;
}

export async function setRecordingEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(RECORDING_ENABLED_KEY, JSON.stringify(enabled))
    .run();
}
```

- [ ] **Step 4: Write the failing API test**

Add to `test/api/settings.test.ts` (follow its existing style; `staff` admin vs non-admin helpers likely exist — mirror the business-hours PUT test):

```typescript
import { handleGetRecording, handlePutRecording } from "../../src/api/settings";
const admin = { email: "a@b.com", role: "admin" as const };
const staff = { email: "s@b.com", role: "staff" as const };
function putRec(body: unknown) { return new Request("https://x/api/settings/recording", { method: "PUT", body: JSON.stringify(body) }); }

describe("/api/settings/recording", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM settings WHERE key = 'recording_enabled'").run(); });
  it("GET returns default true", async () => {
    expect(await (await handleGetRecording(env.DB)).json()).toEqual({ recording_enabled: true });
  });
  it("admin PUT sets it; staff PUT is forbidden", async () => {
    expect((await handlePutRecording(putRec({ recording_enabled: false }), env.DB, admin)).status).toBe(200);
    expect(await (await handleGetRecording(env.DB)).json()).toEqual({ recording_enabled: false });
    expect((await handlePutRecording(putRec({ recording_enabled: true }), env.DB, staff)).status).toBe(403);
  });
});
```

- [ ] **Step 5: Implement in `src/api/settings.ts`** (reuse the existing `forbiddenUnlessAdmin`, `jsonResponse`, `INVALID_BODY_RESPONSE`)

```typescript
import { getRecordingEnabled, setRecordingEnabled } from "../db/settings";

export async function handleGetRecording(db: D1Database): Promise<Response> {
  return jsonResponse({ recording_enabled: await getRecordingEnabled(db) });
}

export async function handlePutRecording(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  let body: unknown;
  try { body = await request.json(); } catch { return INVALID_BODY_RESPONSE(); }
  if (typeof body !== "object" || body === null || typeof (body as { recording_enabled?: unknown }).recording_enabled !== "boolean") {
    return INVALID_BODY_RESPONSE();
  }
  await setRecordingEnabled(db, (body as { recording_enabled: boolean }).recording_enabled);
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 6: Wire the route in `src/worker.ts`**

Add the import: `import { ..., handleGetRecording, handlePutRecording } from "./api/settings";`
In the `adminOnlyRead` condition, add `/api/settings/recording` to the GET list alongside `business-hours`/`call-blocklist`.
After the `/api/settings/call-blocklist` block:

```typescript
      if (url.pathname === "/api/settings/recording") {
        return request.method === "PUT" ? handlePutRecording(request, env.DB, staff) : handleGetRecording(env.DB);
      }
```

- [ ] **Step 7: Run tests, typecheck, full suite, commit**

Run: `npx vitest run test/db/settings.test.ts test/api/settings.test.ts` (pass); `npx tsc --noEmit; echo $?` (`0`); `npx vitest run` (all green).

```bash
git add src/db/settings.ts src/api/settings.ts src/worker.ts test/db/settings.test.ts test/api/settings.test.ts
git commit -m "feat(recording): business-wide recording_enabled setting + admin API

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Honor the recording setting in the conference TwiML

**Files:**
- Modify: `src/twilio/conferenceTwiml.ts` (`renderDialAgentIntoConference`)
- Modify: `src/worker.ts` (2 callers) and `src/durable-objects/CallSession.ts` (1 caller)
- Test: `test/twilio/conferenceTwiml.test.ts`

**Interfaces:**
- Consumes: `getRecordingEnabled` (Task 1).
- `renderDialAgentIntoConference(opts)` gains `record?: boolean` (default `true`). When `false`, the `<Conference>` omits `record="record-from-start"` and `recordingStatusCallback`.

- [ ] **Step 1: Write the failing test**

Add to `test/twilio/conferenceTwiml.test.ts`:

```typescript
it("omits recording attributes when record is false", () => {
  const xml = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r", record: false });
  expect(xml).not.toContain("record=");
  expect(xml).not.toContain("recordingStatusCallback");
});
it("records by default (record omitted) and when record is true", () => {
  const def = renderDialAgentIntoConference({ conferenceName: "CAx", actionUrl: "https://x/a", recordingStatusCallbackUrl: "https://x/r" });
  expect(def).toContain('record="record-from-start"');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/twilio/conferenceTwiml.test.ts`
Expected: FAIL — record attrs always present.

- [ ] **Step 3: Implement in `renderDialAgentIntoConference`**

Change the opts type to include `record?: boolean`, and build the conference attributes conditionally. Replace the `<Conference …>` construction so that when `record === false` neither `record="record-from-start"` nor the `recordingStatusCallback`/`recordingStatusCallbackMethod` attributes are emitted; otherwise emit them exactly as today. (Read the current lines 25-40 of the file and thread a `const rec = opts.record === false ? "" : ' record="record-from-start" recordingStatusCallback="…" recordingStatusCallbackMethod="POST"';` — keep the existing `escapeXml` on the callback URL.)

- [ ] **Step 4: Update the 3 callers to pass the setting**

- `src/durable-objects/CallSession.ts:628` — this method has `this.env.DB`; read `const record = await getRecordingEnabled(this.env.DB);` before the render and pass `record`. Add the import `import { getRecordingEnabled } from "../db/settings";`.
- `src/worker.ts:407` and `src/worker.ts:486` — both have `env.DB`; read `const record = await getRecordingEnabled(env.DB);` and pass `record` in the `renderDialAgentIntoConference({ … })` call.

- [ ] **Step 5: Run test, typecheck, full suite, commit**

Run: `npx vitest run test/twilio/conferenceTwiml.test.ts`; `npx tsc --noEmit; echo $?`; `npx vitest run` (all green — default-on keeps every existing recording assertion valid).

```bash
git add src/twilio/conferenceTwiml.ts src/worker.ts src/durable-objects/CallSession.ts test/twilio/conferenceTwiml.test.ts
git commit -m "feat(recording): conference recording honors the business recording_enabled setting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Missed-call + voicemail push sends (gated)

**Files:**
- Modify: `src/api/push.ts` (add `notifyMissedCall`, `notifyVoicemail`)
- Modify: `src/durable-objects/CallSession.ts` (call them)
- Test: `test/api/push.test.ts` (create if absent), `test/durable-objects/CallSession.test.ts`

**Interfaces:**
- Consumes: `getPushTokensForType` (Plan 1), `sendExpoPush`, `deletePushTokens`, `findContactByPhone`.
- Produces:
  - `notifyMissedCall(db: D1Database, callerNumber: string): Promise<void>` — pushes to `notif_missed` recipients, title `Missed call from {name-or-number}`.
  - `notifyVoicemail(db: D1Database, callerNumber: string): Promise<void>` — pushes to `notif_voicemail` recipients, title `New voicemail from {name-or-number}`.

- [ ] **Step 1: Write the failing test** (mirror how `notifyInboundSms` is structured; gate assertion like `getPushTokensForType`)

Create/extend `test/api/push.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyMissedCall, notifyVoicemail } from "../../src/api/push";
import { setUserSettings } from "../../src/db/userSettings";

async function addToken(token: string, email: string) {
  await env.DB.prepare("INSERT INTO staff_users (email, role, created_at) VALUES (?, 'staff', 1) ON CONFLICT(email) DO NOTHING").bind(email).run();
  await env.DB.prepare("INSERT INTO push_tokens (token, platform, staff_email, created_at, last_seen) VALUES (?, 'ios', ?, 1, 1)").bind(token, email).run();
}

describe("call notifications", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_tokens").run();
    await env.DB.prepare("DELETE FROM user_settings").run();
    await env.DB.prepare("DELETE FROM staff_users WHERE email LIKE '%@n.test'").run();
  });
  it("notifyMissedCall pushes only to notif_missed recipients", async () => {
    await addToken("t-on", "on@n.test");
    await addToken("t-off", "off@n.test");
    await setUserSettings(env.DB, "off@n.test", { notif_missed: false });
    const sent: string[][] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyMissedCall(env.DB, "+61400000000");
    vi.unstubAllGlobals();
    // Expo push posts the recipient token list in the body; assert t-off is excluded.
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body ?? "");
    expect(body).toContain("t-on");
    expect(body).not.toContain("t-off");
  });
});
```

(If `sendExpoPush` batches or formats differently, adapt the body assertion to match its actual request shape — read `src/push/expoPush.ts` first.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/api/push.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `src/api/push.ts`** (mirror `notifyInboundSms`)

```typescript
export async function notifyMissedCall(db: D1Database, callerNumber: string): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_missed");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, callerNumber);
  const who = contact?.name || callerNumber;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `Missed call from ${who}`,
    body: "Nobody answered this call.",
    data: { type: "missed_call", from: callerNumber },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}

export async function notifyVoicemail(db: D1Database, callerNumber: string): Promise<void> {
  const tokens = await getPushTokensForType(db, "notif_voicemail");
  if (tokens.length === 0) return;
  const contact = await findContactByPhone(db, callerNumber);
  const who = contact?.name || callerNumber;
  const { invalidTokens } = await sendExpoPush(tokens, {
    title: `New voicemail from ${who}`,
    body: "Tap to listen.",
    data: { type: "voicemail", from: callerNumber },
  });
  if (invalidTokens.length) await deletePushTokens(db, invalidTokens);
}
```

- [ ] **Step 4: Call them from the DO** (fire-and-forget; never let a push failure break call handling)

In `src/durable-objects/CallSession.ts`:
- Add import: `import { notifyMissedCall, notifyVoicemail } from "../api/push";`
- At the voicemail-left point (~line 159, after `logEvent("voicemail_left", …)`): look up the caller number for this call and call `notifyVoicemail`. The caller number is on the `calls` row (`SELECT caller_number FROM calls WHERE id = ?`) — or reuse a value already loaded nearby. Wrap in try/catch or `.catch(() => {})`.
- At the no-answer point (~line 566, after `logEvent(abandonedMidRing ? "caller_hung_up" : "no_answer")`): fetch the caller number and call `notifyMissedCall`. Same fire-and-forget guard.

Use `this.env.DB`. Example pattern for each site:

```typescript
    try {
      const row = await this.env.DB.prepare("SELECT caller_number FROM calls WHERE id = ?").bind(callSid).first<{ caller_number: string }>();
      if (row?.caller_number) await notifyMissedCall(this.env.DB, row.caller_number);
    } catch { /* notifications are best-effort */ }
```

- [ ] **Step 5: Add a DO integration test**

Add to `test/durable-objects/CallSession.test.ts` a case that seeds a push token (with a staff row + `notif_missed` default on), drives a call to the no-answer fall-through (the file already has a no-answer/voicemail scenario to copy), and asserts the Expo push endpoint was hit for the missed call (the file's `fetchMock` already intercepts `fetch`; assert a call to the Expo push URL — check `src/push/expoPush.ts` for the exact host, e.g. `exp.host`/`expo.dev`). Keep it minimal — one missed-call assertion.

- [ ] **Step 6: Run tests, typecheck, full suite, commit**

Run: `npx vitest run test/api/push.test.ts test/durable-objects/CallSession.test.ts`; `npx tsc --noEmit; echo $?`; `npx vitest run` (all green).

```bash
git add src/api/push.ts src/durable-objects/CallSession.ts test/api/push.test.ts test/durable-objects/CallSession.test.ts
git commit -m "feat(notifications): send gated missed-call + voicemail push from the DO

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mobile — Call Recording admin row

**Files:**
- Modify: `mobile/src/lib/api.ts` (`getRecordingSetting`/`setRecordingSetting`)
- Modify: `mobile/src/app/(tabs)/settings.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `useAuth` (for `user.role`).

- [ ] **Step 1: Add API helpers to `mobile/src/lib/api.ts`**

```typescript
export async function getRecordingSetting(): Promise<boolean> {
  const r = await apiFetch<{ recording_enabled: boolean }>("/api/settings/recording");
  return r.recording_enabled;
}
export async function setRecordingSetting(enabled: boolean): Promise<void> {
  await apiFetch("/api/settings/recording", { method: "PUT", body: JSON.stringify({ recording_enabled: enabled }) });
}
```

- [ ] **Step 2: Wire the Call Recording row in `settings.tsx`**

Replace the current local `recording` `usePersistedBool` wiring for the "Call Recording" Row with the business setting. Read the current state on mount (`getRecordingSetting`) into local state; the toggle is enabled only for `user?.role === "admin"` (staff see it read-only — pass no `onToggle`, or disable it). On an admin toggle, call `setRecordingSetting(v)` optimistically. Show a footer noting it's a business-wide setting managed by admins. Remove the now-unused `pref_recording` `usePersistedBool` line. Keep the row's icon/label. (Read `settings.tsx` and match the `Row` API: a read-only toggle can be rendered by omitting `onToggle` or by showing `value={enabled ? "On" : "Off"}` for staff.)

- [ ] **Step 3: Bump OTA**

`const OTA_BUILD = "21";` → `const OTA_BUILD = "22";`.

- [ ] **Step 4: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`).

```bash
git add mobile/src/lib/api.ts "mobile/src/app/(tabs)/settings.tsx"
git commit -m "feat(mobile): Call Recording row reflects the business setting (admin-editable) — OTA #22

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end verification

**Files:** none.

- [ ] **Step 1** (user-consent, production): apply no migration (none needed — reuses `settings` table). Deploy the worker (user's step) so the recording toggle + notification sends are live.
- [ ] **Step 2** (user-consent): `cd mobile && npx eas update --branch preview --message "#22 call recording admin row"`.
- [ ] **Step 3 — on-device:**
  - As admin: Settings → Call Recording off → place/receive a call → confirm no recording appears; on → recording appears. As staff: the row is read-only.
  - Leave a voicemail on the business line → a "New voicemail" push arrives (with `notif_voicemail` on); disable it → no push.
  - Let an inbound call go unanswered → a "Missed call" push arrives (with `notif_missed` on).

---

## Self-Review

- **Spec coverage:** Call Recording business-wide + admin-gated (Tasks 1-2, 4); missed-call & voicemail push **sends** now exist and are gated by the Plan 1 per-user toggles (Task 3). "Incoming call" notification is documented as native-only (not a server push). Native audio + auto-answer/call-waiting remain Plan 4.
- **Placeholder scan:** none — concrete code/commands throughout; the two spots that say "read the current file first" are deliberate (matching an existing render string / Row API), not deferred logic.
- **Type consistency:** `getRecordingEnabled`/`setRecordingEnabled`, `handleGetRecording`/`handlePutRecording`, the `record?: boolean` opt, and `notifyMissedCall`/`notifyVoicemail` are used consistently across tasks; notification keys (`notif_missed`, `notif_voicemail`) match the Plan 1 `UserSettings`/`NotifKey`.
- **No-regression:** recording defaults ON so every existing recording assertion holds; each server task re-runs the full suite.

## Follow-on: Plan 4 (Workstream B remainder — native mobile)

Audio Routing + Bluetooth (`voice.getAudioDevices()`/`AudioDevice.select()`), Auto-Answer + Call Waiting (`voice.ts` CallInvite handler). Device-tested; no server component.

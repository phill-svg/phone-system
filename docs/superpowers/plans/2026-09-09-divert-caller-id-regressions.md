# Divert Caller-ID Regressions — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. Written after a
> whole-repo `/code-review` found four defects introduced by #67 (the divert caller ID) on the day
> it shipped.

**Goal:** Remove the four regressions #67 introduced. The worst can hang up a live customer call on
a transient database error — a path that used to fall through to voicemail.

**Architecture:** No schema change, no new endpoint, no behaviour change to the feature itself. Each
fix restores an invariant #67 broke.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, vitest (`@cloudflare/vitest-pool-workers`),
Expo SDK 54.

## Global Constraints

- Deploys run from `.github/workflows/deploy.yml` on push to `master`. **PRs run no CI**, so the
  scratchpad preflight is the only gate before merge.
- Verify with `npx tsc --noEmit` (never pipe into `head` — a pipe swallows the exit code).
- Worker tests via the scratchpad `localtest.sh`.
- Task 4 touches `mobile/`, so `OTA_BUILD` must be bumped **and an OTA published** — the worker
  deploy alone will not reach handsets.
- No migration.

## File Structure

- Modify `src/durable-objects/CallSession.ts` — `callerId()` cannot throw; clear the recorded
  rejection once per call on a successful divert.
- Modify `src/twilio/restClient.ts` — narrow `isCallerIdRejection` to HTTP 400.
- Modify `src/db/settings.ts` — add `clearDivertCallerIdRejection`.
- Modify `mobile/src/app/admin/index.tsx` + `mobile/src/lib/build.ts` — disable the toggle until
  loaded; bump OTA_BUILD.
- Tests: `test/durable-objects/CallSession.test.ts`, `test/twilio/restClient.test.ts`,
  `test/api/settings.test.ts`.

---

### Task 1: A caller-ID lookup must never hang up a live call

**Files:** Modify `src/durable-objects/CallSession.ts`; test `test/durable-objects/CallSession.test.ts`

#67 hoisted `const from = await this.callerId()` out of `dialBatch`'s per-leg loop for performance —
and in doing so put it **above** the try/catch. Every `dialStaff` call used to be wrapped, so a
failure returned `null` and the caller fell through to business voicemail. Now a transient D1 error
inside `resolveSendingNumber` escapes `dialBatch` → `startRing` → `handleMainWebhook` to the DO's
catch-all, which answers "Sorry, we're experiencing a technical issue" and hangs up. Via
`performDeferredDial` it does the same to a caller already waiting on hold.

The fix belongs in `callerId()` rather than at the call site: it already falls back to
`TWILIO_FROM_NUMBER` for an invalid *value*, so it should do the same for a failed *read*. That
protects the cascade path too, which calls it separately.

- [x] **Step 1:** Failing test — make the phone_numbers read throw, assert the ring still dials
      (from the env fallback) rather than rendering the technical-issue hangup.
- [x] **Step 2:** Wrap the resolve in try/catch, log `CALLER_ID_LOOKUP_FAILED`, fall back.
- [x] **Step 3:** Test passes.

### Task 2: A rejection must not pin Health Checks red for a week

**Files:** Modify `src/db/settings.ts`, `src/durable-objects/CallSession.ts`; test `test/api/settings.test.ts`

`recordDivertCallerIdRejection` writes `divert_caller_id_last_error` and **nothing ever clears it**.
One anonymous caller, or one transient 400, leaves Admin > Health Checks reporting "Diverted calls
are silently ringing from the business number instead" for seven days while every divert works. A
check that cannot recover is worse than no check — it trains you to ignore it.

Cleared at most **once per call** (an instance flag, like `divertMemo`), so this does not put a
write back into the per-leg ring hot path that #67 was fixing.

- [x] **Step 1:** Add `clearDivertCallerIdRejection(db)`.
- [x] **Step 2:** Call it on the first successful divert leg of a call.
- [x] **Step 3:** Test the round trip: record, clear, check reads healthy again.

### Task 3: An expired API key must not read as a caller-ID problem

**Files:** Modify `src/twilio/restClient.ts`; test `test/twilio/restClient.test.ts`

`isCallerIdRejection` returns true for **any** 4xx except 429. So a revoked
`TWILIO_API_KEY_SECRET` (401) makes every divert leg dial twice during an outage, and records
`divert_caller_id_last_error = {status: 401}` — pointing Health Checks at the divert feature instead
of the credentials.

Narrowed to **HTTP 400 only**. Twilio's caller-ID rejections (21210 "'From' phone number not
verified", 21212, 13224) are all 400 validation errors; 401/403 are auth, 404 is not-found, 429 is
throttling, 5xx may have created the call. Keeping the whole 400 class rather than an allowlist of
codes is deliberate: an unrecognised validation error should still fall back to the business number
rather than drop the leg and send the caller to voicemail.

- [x] **Step 1:** Tests — 400 retries; 401, 403, 404, 429 and 500 do not.
- [x] **Step 2:** Narrow the predicate.

### Task 4: The toggle I added must not lie while it loads

**Files:** Modify `mobile/src/app/admin/index.tsx`, `mobile/src/lib/build.ts`

#70 added `toggleDisabled` to `Row` precisely because a switch defaulted to `false` while the server
says `true` invites an admin to "turn it on" (a no-op) and then off again to test — which genuinely
disables it. That prop was applied to Call Recording and **not** to the divert row added in the same
work, which is the one whose server default is ON.

- [x] **Step 1:** `toggleDisabled={divertCallerId === null}`.
- [x] **Step 2:** Bump `OTA_BUILD` 56 → 57.

### Task 5: Record what these have in common

**Files:** Modify `CLAUDE.md`

- [x] **Step 1:** One bullet: resolving the caller ID must never throw on the ring path, and the
      rejection marker is self-clearing.

---

## Deliberately not done (found in the same sweep, separate work)

Tier 2 from the whole-repo review — real, but pre-existing rather than shipped today: removed staff
keep receiving customer push notifications; the web Away button never persists; web Recents still
uses the old `!ivr_path` missed rule; a second recording callback blanks `recording_url`; three
admin pages render timestamps in UTC; an old reset link survives a password reset; the IVR editor's
`h()` does not escape quotes. Raise as its own plan.

# tcbvoip.app Migration — Design (Workstream A)

**Date:** 2026-08-27
**Status:** Approved — ready for implementation plan
**Scope:** Cut the VoIP system over to the canonical domain `tcbvoip.app` without breaking the
currently-working calling on `phone.tcbpestcontrolcanberra.com.au`.

This is the first of four workstreams in the larger "get TCB Phone ready for the App Store and
Play Store" effort. The others are summarised at the bottom for context but are **out of scope**
for this spec:

- **B** — Make every Settings row genuinely functional (per-user settings store). *Next spec.*
- **C** — iOS App Store submission (incl. reviewer demo account, privacy labels).
- **D** — Google Play submission.

---

## Goal

`tcbvoip.app` becomes the canonical public domain for the worker and the mobile app, with
`phone.tcbpestcontrolcanberra.com.au` retained as a live fallback. Calling (in and out), SMS,
push notifications, and the public legal pages must all work on `tcbvoip.app`.

## Success criteria

The migration is **done** when, on `tcbvoip.app`:

1. `https://tcbvoip.app/privacy` and `https://tcbvoip.app/terms` render the legal pages.
2. `https://tcbvoip.app/login` loads.
3. The mobile app (already pointed at `tcbvoip.app`) can place an **outbound** call.
4. The mobile app receives an **inbound** call.
5. An **inbound SMS** to `+61485034869` is received and stored.
6. A **push notification** for an incoming call/SMS is delivered to a device.
7. `phone.tcbpestcontrolcanberra.com.au` still works (fallback intact — no regression).

## Why this is low-risk

- `wrangler.jsonc` keeps **both** custom-domain routes on the **same** worker, so both hostnames
  serve identical code simultaneously. There is no flip-the-switch moment.
- Every in-code Twilio callback URL is built from `url.origin` and self-heals to whatever host
  Twilio hit. The only URLs that don't self-heal are the ones **statically configured in the
  Twilio console** (TwiML app voice URL, number VoiceUrl/StatusCallback, SMS inbound webhook).
- Those console URLs currently point at `phone.tcb…`, which **stays live**. So repointing them to
  `tcbvoip.app` is a *canonicalization* step that lets us retire `phone.tcb…` later — **not** a
  break-fix. Calling keeps working throughout.

## Current state (verified 2026-08-27)

- **Code already migrated (uncommitted):**
  - `wrangler.jsonc` — adds `{ "pattern": "tcbvoip.app", "custom_domain": true }` alongside the
    existing `phone.tcb…` route.
  - `src/worker.ts` — serves `/privacy` and `/terms` (public, no-auth) via new
    `src/html/pages/legal.ts`.
  - `src/html/pages/legal.ts` — new Privacy Policy + Terms of Service pages (staff-only-tool
    framing; lists Twilio/Cloudflare/APNs/FCM as processors; contact
    `phill@tcbpestcontrolcanberra.com.au`).
  - `mobile/.env` — `EXPO_PUBLIC_API_BASE_URL=https://tcbvoip.app`.
  - `mobile/src/lib/api.ts` — default `BASE_URL` → `https://tcbvoip.app`, now exported.
  - `mobile/src/app/(tabs)/settings.tsx` — Privacy Policy / Terms rows now open
    `${BASE_URL}/privacy` and `${BASE_URL}/terms`; `OTA_BUILD` bumped 17 → 19.
  - `src/twilio/ringback.ts` — minor change (unrelated cleanup carried in the working tree).
- **Domain:** `tcbvoip.app` is already a live Cloudflare custom domain (confirmed by user).
- **Grep:** the old hostname now appears **only** in `wrangler.jsonc` (the intentional fallback
  route). No hardcoded `phone.tcb…` remains in application code.

## Implementation steps

### 1. Commit the migration code
Commit the working-tree changes as a single, reviewable commit. Confirm `tsc` passes before
committing (`npx tsc --noEmit; echo $?` — do **not** pipe through `head`, which swallows the exit
code; per project convention). Do not include the Claude-Session URL trailer (repo convention).

### 2. Deploy the worker
Deploy from `master` (the live-deploy branch) via wrangler. After deploy, confirm the `tcbvoip.app`
route is bound and TLS is valid.

### 3. Verify public surfaces on tcbvoip.app
- `GET https://tcbvoip.app/privacy` → 200, renders Privacy Policy, `/logo.png` loads.
- `GET https://tcbvoip.app/terms` → 200, renders Terms of Service.
- `GET https://tcbvoip.app/login` → 200.

### 4. Repoint Twilio console webhooks (manual — user)
Swap **only the hostname** to `tcbvoip.app`; **keep the path and the `?whsec=<secret>` query
string** exactly (`?whsec=` is the primary webhook auth; a URL missing it 401s). These fields do
not self-heal because they are configured statically in Twilio.

**AU1 region console** (region selector must read AU1 — the account is AU1-homed; the AU1 TwiML
apps are invisible to Auth-Token API calls):
- TwiML app **"tcb-voip softphone"** → Voice Request URL host → `tcbvoip.app` (keep path +
  `?whsec`). *(Verify the whsec is present — historically the outbound TwiML app's voice_url was
  missing it.)*
- Number **`+61866108941`** (`PN85f0875f9f35826a41c5eb674398c445`):
  - Voice URL: `https://tcbvoip.app/webhooks/twilio?whsec=…`
  - Status Callback: `https://tcbvoip.app/webhooks/twilio/status?whsec=…`

**US1 region console** (SMS lives only in US1 — separate zone):
- SMS number **`+61485034869`** inbound message webhook → host → `tcbvoip.app` (keep path +
  `?whsec`).

Leave the AU1/US1 fallback in mind: because `phone.tcb…` stays live, an incorrect edit here does
not take calling down — the pre-edit URLs still resolve. Repoint, then verify (step 5); if a call
fails, revert the single field to `phone.tcb…`.

### 5. Regression test on tcbvoip.app
With the mobile app (pointed at `tcbvoip.app`):
- Place an outbound call → connects, two-way audio.
- Receive an inbound call to the business number → device rings, answers, two-way audio.
- Send an inbound SMS to `+61485034869` → appears in the app / stored.
- Confirm a push notification arrives for an incoming call and for an inbound SMS.

### 6. Confirm fallback intact
Confirm a call still completes while the softphone/token flow runs against `tcbvoip.app`, and that
`phone.tcb…` endpoints still return 200 (route retained for rollback). Do **not** remove the
`phone.tcb…` route in this workstream — retiring it is a separate, later task once tcbvoip.app has
been stable in production.

## Out of scope / explicitly deferred

- Removing the `phone.tcb…` route or DNS.
- Any Settings functionality changes beyond the already-made Privacy/Terms link wiring
  (that is Workstream B).
- App-store build/submission (Workstreams C/D).
- Automating the Twilio repoint via an AU1 API key (user will edit the console manually).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| A repointed Twilio URL drops `?whsec` → 401 → "application error" on calls | Copy path+query verbatim; only change host. Verify in step 5; revert the single field if it fails. |
| Editing the US1 TwiML app instead of the real AU1 "tcb-voip softphone" app | Confirm region selector reads AU1 before editing; the US1 app ("dvb", `AP1a33…`) is not the softphone's app. |
| tcbvoip.app TLS/route not fully propagated | Step 2 verifies TLS + route binding before any Twilio change. |
| Regression on the working system | Both routes stay live the entire time; rollback = revert a single console field. |

## Roadmap context (later specs — not this one)

- **B — Settings functionality (per-user).** New per-user settings store + API. Server-backed:
  Call Forwarding (forward inbound to a number), Call Recording toggle, Notification gating
  (server honors prefs before sending push). App/native: Call Waiting (handle 2nd invite),
  Auto-Answer. Native-audio (risk — depends on `@twilio/voice-react-native-sdk` v2-preview
  AudioDevice API being usable): Audio Routing picker, Bluetooth. Preferences currently persist
  only in on-device SecureStore; B syncs them to the server where behavior requires it.
- **C — iOS App Store.** EAS production build → TestFlight → review. Must include a **reviewer
  demo account** in review notes (staff-only app, no public signup → otherwise near-automatic
  rejection). App Privacy questionnaire / data-safety labels, screenshots.
- **D — Google Play.** AAB build → internal testing → review, mirroring C.

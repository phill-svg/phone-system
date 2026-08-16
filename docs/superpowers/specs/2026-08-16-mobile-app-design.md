# TCB VoIP mobile app — design

**Date:** 2026-08-16
**Status:** Phase 1 approved (brainstorm), pending implementation plan
**Author:** Phill + Claude

## Vision

A native **iOS + Android** companion app for TCB staff: a **softphone** (receive
and make calls, ringing in the background like a real phone) plus a **near-full
dashboard** — contacts, call history, live calls board, call detail
(recording/notes/disposition), callback requests, and an available/away presence
toggle. It complements the existing web admin, which remains the home for IVR
editing, settings, and analytics.

## Stack (decided during brainstorm)

- **Expo (React Native) + EAS Build** — cloud builds, so no Mac is required.
- **Twilio Voice React Native SDK** for calling — drives **CallKit** on iOS and
  **ConnectionService** on Android for the native incoming-call / in-call UI.
- **Reuses the existing Cloudflare Worker API** and the **email + password auth**
  already built. No separate account system.

## Prerequisites / constraints

- **Test devices:** physical iPhone + physical Android (Phill has both). VoIP
  push (background ringing) cannot be tested on simulators/emulators.
- **Paid accounts:** Apple Developer ($99/yr) — needed for the iOS VoIP push
  certificate at Phase 4; Google Play ($25 one-time) — only for publishing to the
  Play Store. **Android background push is free** via Firebase + APK sideload.
- No Mac — all iOS builds go through EAS in the cloud.

## Phase breakdown (each phase = its own spec → plan → build)

1. **Backend mobile-enablement** — *this spec.* Worker-only; no accounts, no
   mobile toolchain. Fully testable with the existing vitest setup.
2. **Expo app shell** — app + login + read-only screens (contacts, history, live
   calls, call detail, callbacks, presence). Installs on a real phone via EAS.
   No calling yet — de-risks the toolchain before VoIP.
3. **Foreground softphone** — Twilio Voice SDK: make/take calls while the app is
   open; in-call controls.
4. **Background incoming calls** — PushKit/CallKit (iOS) + FCM/ConnectionService
   (Android) so it rings when closed. The hardest part.
5. **Store submission** — builds, signing, TestFlight / Play internal testing,
   review.

---

# Phase 1 — Backend mobile-enablement (detailed)

**Goal:** make the Worker API consumable by a mobile client and let it mint
Twilio Voice tokens the mobile SDK understands. All server-side, no new UI.

## Current state it builds on

- `requireStaffUser(request, env, { isApi })` resolves the user from the browser
  **session cookie** (`src/access/requireStaffUser.ts`), backed by the `sessions`
  table. Dev bypass (`AUTH_MODE=dev`) is preserved for tests.
- `mintAccessToken` (`src/twilio/accessToken.ts`) already grants
  `voice: { incoming:{allow:true}, outgoing:{application_sid} }`, au1-homed.
- `handleGetSoftphoneToken` (`src/api/softphone.ts`) mints a token for the
  browser softphone.
- Login/session/rate-limit/password modules from the auth feature are all
  reusable: `verifyPassword`, `getDummyHash`, `createSession`, `destroySession`,
  `lookupSession`, `parseSessionCookie`, `isRateLimited`/`recordFailedAttempt`/
  `clearAttempts`.

## Components

### 1. Bearer-token API auth
Extend `requireStaffUser` so that, in non-dev mode, it resolves the session from
**either** the `tcb_session` cookie **or** an `Authorization: Bearer <token>`
header. The bearer token is the *same* opaque session token (only its SHA-256 is
stored). Resolution order: cookie first; if absent/invalid, try the bearer
header; if neither yields a live session, return the existing
401 (api) / 302 (page) response. No change to the cookie path or the dev bypass.

New helper: `parseBearerToken(request): string | null` (reads `Authorization`,
strips a case-insensitive `Bearer ` prefix).

### 2. JSON login endpoint
Add `POST /api/login` — JSON in, JSON out — for the app:
- Body: `{ "email": string, "password": string }`.
- Success → `200 { "token": string, "user": { "email": string, "role": "admin"|"staff" } }`.
- Wrong email/password → `401 { "error": "Invalid email or password." }` (with the
  same dummy-verify anti-enumeration as the web login).
- Rate-limited (≥8 fails/15 min) → `429 { "error": … }`.
- Missing fields → `400`.
Reuses `verifyPassword`, `getDummyHash`, `isRateLimited`/`recordFailedAttempt`/
`clearAttempts`, and `createSession`. It does **not** set a cookie (the app
stores the returned token and sends it as a Bearer header).

This route is **public** — registered before the `/api/` staff gate, alongside
the existing `/login`.

### 3. Mobile Voice token
- Extend `mintAccessToken` opts with an optional `pushCredentialSid?: string`.
  When present, include it in the voice grant:
  `voice: { incoming:{allow:true}, outgoing:{application_sid}, push_credential_sid }`.
  Twilio uses this to deliver the VoIP push that wakes the device for incoming
  calls. When absent, the grant is exactly as today (fine for foreground calling).
- Extend the token endpoint so a mobile client can request a token carrying the
  right platform credential: `GET /api/softphone/token?platform=ios|android`
  includes `TWILIO_PUSH_CREDENTIAL_SID_IOS` / `TWILIO_PUSH_CREDENTIAL_SID_ANDROID`
  from env when set. No `platform` param (or unset env) → today's behaviour.
  These env vars are **optional** and only get real values at Phase 4.

### 4. Token logout
Add `POST /api/logout` — reads the presented session token (cookie or bearer),
`destroySession`s it, returns `200 { ok: true }`. Public route (it authenticates
itself via the token it's revoking). Idempotent — no token → still `200`.

## Env additions (all optional)
- `TWILIO_PUSH_CREDENTIAL_SID_IOS?`
- `TWILIO_PUSH_CREDENTIAL_SID_ANDROID?`

## Route placement
`/api/login` and `/api/logout` are registered **before** the `/api/`
`requireStaffUser` gate (so they're reachable unauthenticated), next to the
existing public `/login` block. The gated `/api/*` handlers are unchanged except
that `requireStaffUser` now also accepts a bearer token.

## Security
- Bearer tokens ARE session tokens — same `sessions` table, same 12h expiry, same
  server-side revocation (logout / staff removal / reset). Only SHA-256 hashes are
  stored.
- `/api/login` carries the same rate-limiting and anti-enumeration as `/login`.
- HTTPS only (Cloudflare terminates TLS). Tokens never logged.
- No new privilege surface: bearer auth resolves to the same `staff_users` row
  check as cookie auth.

## Testing (vitest, existing pool)
- `requireStaffUser`: valid bearer → user; invalid/expired bearer → 401 (api);
  cookie still works; cookie-and-bearer both absent → 401/302; dev bypass intact.
- `POST /api/login`: success returns `{token,user}` and the token actually
  authenticates a subsequent `/api/*` call; wrong password → 401 (no token);
  unknown email → 401 (+ dummy verify path); rate-limit → 429; missing fields → 400.
- `POST /api/logout`: after logout the previously-valid bearer token → 401.
- `mintAccessToken`: includes `push_credential_sid` in the grant when provided,
  omits it when not; overall grant shape unchanged otherwise.

## Out of scope (Phase 1)
- Any mobile UI / Expo project (Phase 2).
- Creating Twilio push credentials or APNs/FCM setup (Phase 4).
- Client-side device registration — the Twilio Voice SDK registers the device's
  push token with Twilio directly using the access token; no backend endpoint
  needed for it.
- Refresh tokens / token rotation — the 12h session + re-login is sufficient for v1.

## Rollout
Phase 1 is additive and safe to deploy anytime: new public routes, a widened
`requireStaffUser`, and an optional token grant field. Nothing changes for the
existing web app. The push-credential env vars stay empty until Phase 4.

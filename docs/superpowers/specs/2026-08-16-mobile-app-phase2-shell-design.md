# TCB VoIP mobile app — Phase 2 design (app shell + auth + Live Calls slice)

**Date:** 2026-08-16
**Status:** Approved (brainstorm), pending implementation plan
**Author:** Phill + Claude
**Parent:** `2026-08-16-mobile-app-design.md` (Phase 2 of the 5-phase program)

## Goal

Stand up the Expo app as a **thin vertical slice**: it launches, lets a staff
member log in against the Worker API (Phase 1 endpoints), stores the session
token securely, and shows **one** live-data screen (Live Calls). This proves the
whole app → login → token → authenticated API → real data pipeline on a physical
phone before the remaining dashboard screens are built.

## Verification reality

Automated coverage for this phase is TypeScript typecheck + jest/RNTL unit tests
of the pure logic (API client, token store, auth reducer). The definitive check —
"does it run and log in on the phone" — is Phill installing an **EAS dev build**
on the test iPhone/Android. This phase is collaborative: Claude builds, Phill
installs and reports.

## Location & stack (locked)

- App lives in **`mobile/`** (lightweight monorepo; the Worker stays at repo root).
- **Expo** (latest SDK) with a **Dev Client** + **EAS Build** — NOT Expo Go
  (Phase 3 needs Twilio's native Voice module, which Expo Go can't load; setting
  up the dev-client path now avoids rework).
- **Expo Router** (file-based) with a bottom tab bar.
- **expo-secure-store** for the session token (iOS Keychain / Android Keystore).
- **TanStack Query** for data fetching/caching.
- **TypeScript**, matching the Worker's strictness.
- **TCB brand** reused: bg `#0f1013`, surface `#1b1d24`, brand `#e4002b`, text `#eceef2`.

## API base URL

- `EXPO_PUBLIC_API_BASE_URL` — defaults to `https://phone.tcbpestcontrolcanberra.com.au`.
- For local development against `wrangler dev`, it can be overridden, but a
  physical phone testing via EAS should point at the deployed URL.

## Dependency: Phase 1 must be deployed

The app authenticates via `POST /api/login` and `Authorization: Bearer`, which
exist in the merged Phase-1 backend but are **not yet deployed to production**.
Before the app can log in against `phone.tcbpestcontrolcanberra.com.au`, Phill
must `npm run deploy` (Phase 1 is additive and safe). Documented in rollout.

## File structure (`mobile/`)

```
mobile/
  app.json / app.config.ts     Expo config (name, scheme, plugins, EAS project id)
  eas.json                     EAS build profiles (development / preview / production)
  package.json                 app deps (separate from the Worker's)
  tsconfig.json
  app/
    _layout.tsx                Root: QueryClientProvider + AuthProvider + auth gate
    login.tsx                  Email/password login screen
    (tabs)/
      _layout.tsx              Bottom tabs (Live Calls now; others later)
      live.tsx                 Live Calls screen (GET /api/calls/live)
  lib/
    api.ts                     fetch wrapper: base URL + Bearer header + 401 handling
    session.ts                 secure-store token get/set/clear
    auth.tsx                   AuthProvider/useAuth: boot-load token, login(), logout()
    theme.ts                   brand tokens/colors
  components/
    (shared UI as needed)
  __tests__/
    api.test.ts, session.test.ts, auth.test.ts
```

## Components

### `lib/session.ts`
Thin wrappers over `expo-secure-store`: `getToken(): Promise<string|null>`,
`setToken(t): Promise<void>`, `clearToken(): Promise<void>`. Single storage key.

### `lib/api.ts`
`apiFetch(path, opts)` — prefixes `EXPO_PUBLIC_API_BASE_URL`, attaches
`Authorization: Bearer <token>` from `session.getToken()`, sets JSON headers,
parses JSON. On **401** it clears the token and signals a logout (so the auth
gate redirects to login). Exposes typed helpers as needed (e.g.
`login(email,password)`, `logout()`, `getLiveCalls()`).

### `lib/auth.tsx`
`AuthProvider` + `useAuth()`. State: `status: "loading"|"authed"|"anon"`, `user`.
On mount, loads the token from secure-store → `authed`/`anon`. `login(email,pw)`
calls `POST /api/login`, stores `{token}`, sets `user`. `logout()` calls
`POST /api/logout`, clears the token, → `anon`.

### `app/_layout.tsx`
Wraps the tree in `QueryClientProvider` + `AuthProvider`. Redirects: `anon` →
`/login`; `authed` → `/(tabs)`; `loading` → splash.

### `app/login.tsx`
Branded email + password form. Submit → `useAuth().login`. Shows a generic error
on failure (mirrors the API's `"Invalid email or password."`). Disabled/spinner
while pending.

### `app/(tabs)/live.tsx`
Uses TanStack Query to `getLiveCalls()` (GET `/api/calls/live`), polling every
~5s. Renders the list of in-progress calls (caller, called, started-at, status),
with loading + empty + error states. A header **Available/Away** toggle
(`PUT /api/softphone/presence`) can land here or be deferred to the presence
follow-on — kept minimal for the slice.

## Testing

- `session.ts` — get/set/clear round-trips (mock `expo-secure-store`).
- `api.ts` — attaches Bearer when a token exists; omits when not; on 401 clears
  the token and reports unauthorized (mock `fetch` + secure-store).
- `auth.tsx` — boot with a stored token → `authed`; `login` stores token + sets
  user; `logout` clears. (RNTL + mocked api.)
- Typecheck: `tsc --noEmit` in `mobile/`.
- NOT automatable here: the actual EAS build + on-device login.

## Out of scope (Phase 2 follow-on, after the slice proves out)

The other dashboard screens — Call History (+ Call Detail), Contacts, Callbacks,
and the full presence UI — are built after this slice is verified on a device.
They reuse the same `api.ts`/`auth.tsx`/theme and add tabs. No calling (Phase 3).

## Rollout

1. Scaffold `mobile/`, build the auth + Live Calls slice, land the unit tests
   green + `tsc` clean.
2. Phill: create a free Expo account; `npx eas login`; configure the EAS project
   id (Claude wires `eas.json`/`app.json`).
3. **Deploy Phase 1** (`npm run deploy`) so the API accepts mobile login in prod.
4. Phill: `eas build --profile development` for Android (free) — install the APK
   on the test phone; log in; confirm Live Calls shows real data. iOS dev build
   likewise (free Apple ID works for a 7-day dev build).
5. Once the slice is confirmed on-device, build the remaining screens.

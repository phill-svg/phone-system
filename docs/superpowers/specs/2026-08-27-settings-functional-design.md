# Settings — Make Every Row Functional (Workstream B) — Design

**Date:** 2026-08-27
**Status:** Draft — awaiting user review. The two prior product decisions are now resolved by the
fact that **both business numbers (`+61866108941` voice, `+61485034869` SMS/voice) are shared by
all staff** — so inbound call handling, forwarding, and inbound recording are business-wide, while
device/notification/audio preferences remain per-user.
**Depends on:** Workstream A (tcbvoip.app migration) — done.
**Scope:** Every row in the mobile app's Settings screen does something real. No row that only
persists a boolean while doing nothing; no `onPress={() => {}}` stubs.

---

## Goal

Turn the Settings screen from "mostly cosmetic" into fully functional, backed by a real per-user
settings store where behavior must be enforced server-side, and by real device/SDK APIs where
behavior is local to the phone.

## Success criteria

For each row, "functional" is defined concretely in the per-row table below and each has an
observable acceptance check. Overall done when:

1. Every Settings row either performs its real behavior or is honestly presented (no fake toggles).
2. Per-user preferences persist server-side and survive reinstall / new device (not just SecureStore).
3. Changing a preference on the phone provably changes system behavior (push delivery, recording,
   audio route, call handling) — verified on-device.
4. `tsc` clean; existing tests pass; new logic has unit tests where it isn't purely native.

---

## Current state (verified 2026-08-27)

- **Settings store:** `settings` table is global key/value (`key TEXT PK, value TEXT`). Used for
  business hours + call blocklist (`src/db/settings.ts`, `src/api/settings.ts`). No per-user store.
- **Identity:** users are `staff_users` keyed by **email** (role `admin|staff`, password auth).
  The mobile app authenticates with a Bearer token; `requireStaffUser` resolves the caller.
- **Push:** `src/db/pushTokens.ts#getAllPushTokens` returns **all** tokens (broadcasts to everyone);
  `push_tokens` rows carry `staff_email`. `src/push/expoPush.ts` sends. There is currently no
  per-user or per-type gating.
- **Recording:** inbound queue calls **already record** (`queueTwiml.ts`,
  `record="record-from-answer-dual"`). Outbound `/twiml/voice-app` dials into a conference.
- **Audio SDK:** `@twilio/voice-react-native-sdk@2.0.0-preview.2` exposes `voice.getAudioDevices()`
  → `{ audioDevices, selectedDevice }`, `AudioDevice.select()`, types Earpiece/Speaker/Bluetooth,
  and `Voice.Event.AudioDevicesUpdated`. Audio-route control is feasible.
- **Mobile prefs today:** `usePersistedBool` (SecureStore, device-local only) backs Call
  Waiting / Auto-Answer / Recording / Bluetooth / the 3 Notification toggles; theme via
  `useThemePreference`. None are wired to real behavior yet. Privacy/Terms rows now open the
  legal pages (Workstream A). Call Forwarding and Audio Routing are `onPress={() => {}}` stubs.

---

## Architecture

### 1. Per-user settings store (server)
New migration `0022_user_settings.sql`:

```sql
CREATE TABLE user_settings (
  email      TEXT NOT NULL REFERENCES staff_users(email),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,          -- JSON-encoded scalar/object
  updated_at INTEGER NOT NULL,       -- ms epoch
  PRIMARY KEY (email, key)
);
```

Keyed by `(email, key)` so preferences survive device changes and reinstalls, and so the server
can enforce them (push gating, recording).

### 2. Settings API (server)
- `GET /api/settings/me` — returns the caller's settings as a single JSON object, merged over
  server-side defaults. Bearer auth via `requireStaffUser`.
- `PUT /api/settings/me` — accepts a partial JSON object; upserts each provided key for the caller;
  ignores unknown keys (forward-compatible). Returns the merged result.

`src/db/userSettings.ts` (get/set for a given email) + `src/api/userSettings.ts` (handlers),
mirroring the existing `settings` pattern. A single typed `UserSettings` shape + defaults live in a
shared module so server and validation agree.

**Business-wide rows** (Call Recording, Call Forwarding) do **not** use `user_settings`. They extend
the **existing global `settings` table** and `src/db/settings.ts` / `src/api/settings.ts` (same place
as business hours + blocklist), reusing that pattern. Their write handlers are **admin-gated**
(`requireStaffUser` + `role === 'admin'`); staff receive the values read-only. So there are two
stores by design: `user_settings` (per-user, per-device-ish prefs) and `settings` (shared business
config).

### 3. Mobile settings hook
`mobile/src/lib/userSettings.tsx` — a context/hook that:
- On sign-in, fetches `GET /api/settings/me`; caches the result in SecureStore for instant paint
  and offline reads.
- Exposes `settings` + `update(partial)` that optimistically updates local state, writes through
  to `PUT /api/settings/me`, and reconciles.
- Replaces `usePersistedBool` for **server-backed** rows. **Device-only** rows (audio route,
  bluetooth, auto-answer, call-waiting, theme) stay local (SecureStore) — they describe how *this
  phone* behaves and shouldn't roam.

---

## Per-row behavior

Rows are grouped by backing layer. "Local" = device behavior, no server. "Server" = server must
honor it.

### A. Local — app-side call handling (SecureStore; must be *wired*, not just stored)

| Row | Behavior | Wiring | Acceptance |
|-----|----------|--------|------------|
| **Call Waiting** | When a 2nd `CallInvite` arrives during an active call: ON → show a "call waiting" prompt (accept = end current + answer new, in MVP); OFF → auto-reject 2nd invite so caller goes to voicemail. | Extend `voice.ts` CallInvite handler to check for an existing `activeCall` and read the pref. | With a call active, a 2nd inbound call shows the prompt when ON; goes straight to voicemail when OFF. |
| **Auto-Answer** | When a `CallInvite` arrives and ON: auto-accept after a short delay (2s), skipping the ringing screen. | `voice.ts` invite handler; guarded so it never auto-answers a 2nd call while busy. | Inbound call with Auto-Answer ON connects without tapping Answer. |
| **Audio Routing** | Row opens a picker: Automatic / Earpiece / Speaker / Bluetooth. Applies to the active call and persists as the default. | `voice.getAudioDevices()` + `AudioDevice.select()`; subscribe to `AudioDevicesUpdated` to keep the shown value live; "Automatic" = don't force a device. | During a call, selecting Speaker routes audio to speaker; selection sticks for the next call. |
| **Bluetooth** | ON → allow routing to Bluetooth devices; OFF → never auto-route to Bluetooth (prefer earpiece/speaker) even when a BT headset is connected. | Same AudioDevice API; when OFF, filter BT out of auto-selection. | With a BT headset paired: ON routes to it; OFF keeps audio on earpiece/speaker. |

*Call Waiting risk:* the v2-preview SDK's handling of a genuine second simultaneous call is
unverified. MVP = end-current-then-answer (no true hold/swap). True hold/swap is a follow-up if the
preview SDK supports it; the row is still honestly functional in MVP form.

### B. Server — per-user, enforced server-side

| Row | Behavior | Wiring | Acceptance |
|-----|----------|--------|------------|
| **Notifications: Incoming Calls / Missed Calls / Voicemail** | Server does not push a notification of a given type to a user who disabled that type. | Push sends become **typed**; recipient selection joins `push_tokens.staff_email` → `user_settings` and drops tokens whose owner disabled that type. New `getPushTokensForType(type)` replaces blanket `getAllPushTokens()` at notify sites. | Disable "Voicemail" on the phone → leaving a voicemail produces no push to that device; a call still does. |

Note: SMS notifications already exist but have **no** Settings row today. This spec adds an
**"SMS Messages"** notification row for parity, gated the same way. (Small addition; keeps the group
coherent.)

### C. Server — business-wide behavior (numbers are shared by all staff)

Because both numbers are shared, these two rows are **business-wide**, stored in the global
`settings` table, editable in-app by **admins** and shown read-only to staff (so everyone can see
the current state). They are not per-user.

| Row | Behavior | Wiring | Acceptance |
|-----|----------|--------|------------|
| **Call Recording** | Business-wide toggle for whether calls on the shared line(s) are recorded. Governs both the inbound queue dial and outbound `/twiml/voice-app`. Default ON (matches today's inbound behavior). | `queueTwiml.ts` and `/twiml/voice-app` read the global `recording` setting and include/omit `record="record-from-answer-dual"` accordingly. | Turn recording OFF (admin) → a new inbound/outbound call produces no recording; ON → it does. |
| **Call Forwarding** | Business-wide: when ON with a target number, the shared inbound line forwards to that external number instead of ringing the app. Admin sets the number + on/off; staff see current state. | Inbound webhook (`/webhooks/twilio`) checks the global `call_forwarding` setting before the normal queue/IVR path; when enabled, returns `<Dial>` to the target. | Enable forwarding to a mobile (admin) → calling the business number rings that mobile, not the app; disable → normal app ringing resumes. |

*Per-user note:* a future per-user "also ring my personal mobile" enhancement is possible but out of
scope here — it is additive and does not change this business-wide design.

### D. Already functional (no change, listed for completeness)
Account/Registration/Role/Incoming-calls status rows; Appearance (theme); Version; Check for
Updates (OTA); Support (mailto); Privacy Policy / Terms (Workstream A); Preview Incoming Call;
Sign Out.

---

## Resolved decisions

- **Call Recording** and **Call Forwarding** are **business-wide** (admin-editable, staff-read-only),
  resolved by the shared-numbers fact. Recording default stays ON to match today's behavior.
- **Admin gating:** these two rows are editable only by `role = 'admin'`; the `PUT /api/settings`
  path for business settings enforces this server-side (staff PUTs are rejected). Per-user rows have
  no admin gate.

Confirm at review: that business-wide (not per-user) is what you want for these two, and that
recording should default ON.

---

## Build order (for the implementation plan)

1. **Server foundation** — migration `0022`, `db/userSettings.ts`, `api/userSettings.ts`, wire
   `GET/PUT /api/settings/me` into `worker.ts`. Unit tests for get/set/merge.
2. **Mobile foundation** — `userSettings.tsx` hook + SecureStore cache; migrate the server-backed
   rows off `usePersistedBool` onto it. No behavior change yet — just real persistence.
3. **Notifications gating** — typed push + `getPushTokensForType`; gate at each notify site.
4. **Audio (Group A: Audio Routing + Bluetooth)** — device picker + AudioDevice wiring in `voice.ts`
   and a picker UI.
5. **Call handling (Group A: Auto-Answer + Call Waiting)** — invite-handler logic.
6. **Call Recording** — business-wide setting honored in `queueTwiml.ts` + `/twiml/voice-app`
   (admin-gated edit).
7. **Call Forwarding** — business-wide setting honored in the inbound webhook (admin-gated edit).

Each step is independently shippable via OTA and testable on the dev build.

## Testing strategy

- **Server:** unit tests (vitest) for `userSettings` get/set/merge and for `getPushTokensForType`
  filtering (owner disabled type → token excluded).
- **Mobile:** hook logic (optimistic update + reconcile) unit-tested where feasible; the native
  audio/call-handling rows are verified **on-device** against the acceptance checks above (they
  can't be unit-tested meaningfully).
- **Regression:** existing inbound recording + push still work for users with default (all-on) prefs.

## Out of scope

- Admin UI beyond what Call Forwarding (D2) requires.
- True multi-call hold/swap (Call Waiting MVP is end-then-answer).
- Any change to the calling/SMS transport itself.

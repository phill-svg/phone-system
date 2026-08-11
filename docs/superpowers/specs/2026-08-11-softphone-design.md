# Softphone (Aircall-style) Design

## Context

The system was built to ring staff's real mobile/landline numbers via Twilio's REST API whenever the IVR flow reaches a "connect me to staff" point, and outbound click-to-call worked by ringing the staff member's own phone first, then bridging to the target. Phill's actual intent all along was for this to work like Aircall: a real softphone (browser + downloadable desktop app) that staff answer/dial from directly, with the existing IVR flow feeding into it — no personal phone numbers involved at all.

This spec replaces the phone-number-based ring/outbound model with a Twilio Voice-SDK-based softphone, while reusing as much of the existing IVR flow engine, ring-strategy reducer, and dashboard conventions as possible.

## Architecture Overview

- **Twilio Voice JS SDK** (`@twilio/voice-sdk`), loaded via CDN `<script>` tag in a new dashboard page — matches this codebase's zero-build-tooling convention (same approach used for Drawflow in the IVR canvas editor).
- **Access Tokens**: a new staff-gated endpoint (`GET /api/softphone/token`) mints a short-lived Twilio Access Token (signed with a Twilio **API Key** SID/Secret — a new credential, separate from the Account SID/Auth Token already configured) scoped to the requesting staff member's identity (their email). The browser uses this token to register a `Device` with Twilio.
- **TwiML Application**: a one-time Twilio Console resource whose Voice Request URL points at a new Worker route, used whenever the softphone dials outbound (`device.connect(...)`).
- **Every answered call becomes a Twilio Conference.** This is the mechanism that makes mute/hold/transfer possible (see "Call Flow" below) — a plain `<Dial>` bridge can't support those.

## Data Model Changes

New migration (`0008_softphone.sql`):

- `staff_users` gains:
  - `status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('available','away','offline'))`
  - `away_reason TEXT` (nullable free text, e.g. "out to lunch")
  - `schedule TEXT NOT NULL DEFAULT '{"mon":{"open":"07:00","close":"17:00"},"tue":{"open":"07:00","close":"17:00"},"wed":{"open":"07:00","close":"17:00"},"thu":{"open":"07:00","close":"17:00"},"fri":{"open":"07:00","close":"17:00"},"sat":null,"sun":null}'` — JSON, same shape as `BusinessHoursSchedule` (per-day open/close), representing that staff member's working hours. Existing staff rows get this default on migration; edited per-staff afterward in Settings.
  - `last_heartbeat_at INTEGER` (nullable) — updated by a periodic ping from an open softphone tab; used to auto-demote a stale `available`/`away` status to `offline` if the tab disappeared without a clean logout.
- Drop reliance on `staff_ring_list` (the phone-number settings blob) and the `staff_users.mobile_number` column for ring/outbound purposes — both become dead weight once nobody's personal phone rings. (Removed in this migration; nothing else reads them once this ships.)
- `ivr_nodes` `ring`-type `config` changes from `{ target: "all" | "on_call_only", ... }` to `{ target: "all" | string[], ... }` where a `string[]` is a specific list of staff emails chosen in the flow editor. Resolution at ring-time (`resolveRingTargets`, see below) always filters down to whichever of the targeted staff currently resolve to `available`.

## Presence Resolution

A staff member resolves to **available** for ring-targeting purposes only if BOTH:
1. The current time falls within their `schedule` (per-day working hours), AND
2. Their manual `status` is `'available'` (not `'away'` or `'offline'`).

Outside scheduled hours, they're always treated as unavailable regardless of manual `status` — prevents a call ringing someone off-shift who forgot to toggle off. Within scheduled hours, `status` defaults to `'available'` and staff can manually flip to `'away'` (with a reason) or `'offline'`.

`resolveRingTargets` (`src/dial/ringQueue.ts`) is rewritten to take the staff roster + this resolution logic instead of the old `StaffRingEntry[]` phone list, returning Twilio Client identity strings (`client:{email}`) instead of E.164 numbers. `reduceRingPlan` (`src/dial/ringPlan.ts`) is untouched — it already operates on opaque `string[]` targets.

## Call Flow (Conference-based, grafted onto the existing Queue/hold machinery)

The existing ring/hold/cascade/star-press-for-callback logic in `CallSession.ts` is built around Twilio's `<Enqueue>`/`<Gather>` combination, and Twilio Conferences don't reliably support capturing DTMF from a participant waiting alone in one — so the caller stays in the existing Queue, completely unchanged, for the entire ring/hold phase. A real Conference only comes into existence at the moment an agent actually answers, and only the bridge step changes:

- **Inbound, reaching a `ring` node**: unchanged — the caller is `<Enqueue>`'d into the same per-call queue as today, hears hold content, can star-press for a callback. The only change is *who* gets dialed: targets are resolved to Twilio Client identity strings (`client:{email}`) instead of phone numbers (see "Presence Resolution" below), dialed via the same cascade/simultaneous `reduceRingPlan` machinery, unmodified.
- **Answer**: when an agent's Client leg answers (`handleAgentAnswer`), two things happen instead of the old direct `<Dial><Queue>` bridge:
  1. A REST call **redirects the caller's still-enqueued leg** to new TwiML (`POST /Calls/{CallSid}.json` with a `Url` pointing at a new `/webhooks/twilio/join-conference` route) — this pulls the caller out of the queue and into `<Dial><Conference>{callSid}</Conference></Dial>`.
  2. The agent leg's own answer-webhook response is now `<Dial><Conference>{callSid}</Conference></Dial>` too (same conference name), instead of `<Dial><Queue>`.
  3. Both legs are now real Participants in a real Twilio Conference resource, which is what makes hold/transfer possible via the Conference Participants REST API.
- **Mute** = client-side only, no server involvement: Voice SDK `call.mute(true)` on the agent's own leg.
- **Hold** = REST API: look up the conference by friendly name (`callSid`), then update the *other* participant (the caller) with `Hold=true` (Twilio auto-plays hold music). Used when an agent needs to step away mid-call.
- **Transfer**: dial a second agent's Client identity the same way the first was dialed, with an answer-webhook that joins them into the *same* conference name; once they've joined, REST-remove the original agent's participant (warm transfer, brief overlap) or remove them immediately (blind transfer).
- **No answer / nobody available**: unchanged — falls through to the node's existing `noAnswerNextNodeId` (typically voicemail).

## Outbound (from the softphone)

Agent enters a number in the softphone UI and clicks call → `device.connect({ params: { To: number } })` → hits the TwiML Application's Voice URL → the agent's own Client leg is brand new (no pre-existing queue to redirect out of, unlike inbound), so its first TwiML response can join a Conference directly (`<Dial><Conference>{agentCallSid}</Conference></Dial>`, using the agent leg's own CallSid as the conference name); the Worker then REST-dials the target number into that same conference name with the business caller ID. Same mute/hold/transfer controls apply, since it's the same Conference mechanism as inbound. This replaces the old click-to-call "ring my phone first" flow entirely; `handleCreateOutboundCall` and its webhook are removed.

## Dashboard & Desktop App

- New page, `/phone` — the softphone itself: status toggle (Available/Away-with-reason/Offline), dial pad, active-call controls (mute/hold/transfer/hangup), incoming-call alert.
- **Important constraint**: this dashboard is server-rendered, multi-page (full navigation reloads JS state) — so navigating to another dashboard page (call history, settings) while on a call would drop the WebRTC connection. Given this, `/phone` becomes staff's home/primary screen; other dashboard pages open in a separate browser tab/window rather than in-place navigation, so an active call is never interrupted by browsing elsewhere.
- Per-staff working-hours schedule is edited in the existing Settings page, alongside a staff roster listing view (add/remove staff, doesn't change auth provisioning which stays Cloudflare-Access-driven).
- **Desktop app** (`desktop/main.js`): loads `/phone` as its home screen (not the dashboard root). Additions: grant `media` (microphone) permission automatically via `session.setPermissionRequestHandler` (Electron blocks this by default); add a tray icon that keeps the app running when the window is closed (softphone must stay reachable); fire a desktop `Notification` with sound on an incoming-call event even while minimized, clicking it restores/focuses the window.

## Removed/Obsolete

- `src/api/outboundCalls.ts` and its click-to-call webhook route (`/webhooks/twilio/click-to-call`).
- `staff_ring_list` settings key and its Settings-page UI.
- `staff_users.mobile_number` column.
- Direct-phone-number dialing paths in `restClient.ts`'s call sites (the client itself, `createOutboundCall`/`cancelCall`, stays — it's still used to dial Client identities into conferences).

## Call Blocklist

Twilio publishes a standalone "Reject Calls with Blocklist" quick-deploy sample app — not used here, since it's meant for people with no existing backend. Instead, the same behavior is folded directly into the existing inbound webhook:

- New settings key `call_blocklist` (JSON array of E.164 numbers), stored via the same `settings` table pattern as `business_hours` (`src/db/settings.ts`) — `getCallBlocklist(db)` / `setCallBlocklist(db, numbers)`.
- New Settings-page UI section: a textarea/list to add and remove blocked numbers, alongside the existing business-hours and staff-schedule sections.
- In `src/worker.ts`'s `/webhooks/twilio` handler, immediately after Twilio signature verification (before the call reaches the `CallSession` Durable Object at all): if `params.From` is in the blocklist, respond directly with `<Reject/>` TwiML and return — the call never reaches the flow engine, never creates a `calls` row, never rings anyone.

## Twilio Account Setup (operational, last step — like the original Task 14)

1. Create a Twilio **API Key** (Standard) in Console → Account → API keys & tokens. Store the Secret as a Worker secret (`TWILIO_API_KEY_SECRET`); the SID becomes a var (`TWILIO_API_KEY_SID`).
2. Create a **TwiML Application** in Console, Voice Request URL → the new outbound-TwiML Worker route. Store its SID as a var (`TWILIO_TWIML_APP_SID`).
3. Deploy, then verify end-to-end: a staff member goes available in `/phone`, an inbound call rings their softphone, they answer/mute/hold/transfer, and outbound dialing from the softphone works.

## Testing

Everything through the Conference-management logic is unit/integration-testable with mocked `fetch` (same pattern as the existing REST client tests) and mocked Twilio webhook payloads (same pattern as the existing flow-engine/CallSession tests). The Voice SDK's actual browser-side WebRTC behavior, the Electron permission/tray/notification wiring, and the full real-call verification are manual-verification-only, consistent with how the IVR canvas and the original calling system were verified.

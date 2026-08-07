# TCB Pest Control — Self-Hosted VoIP System (Cloudflare + Telnyx)

## Context

TCB Pest Control Canberra (1–3 staff) wants its own phone system instead of a generic hosted PBX: real customers dialing a real number, a standard IVR menu, every call recorded, a **live transcript admins can watch while the call is happening**, **the ability for an admin to listen in live on an active call**, and a lookup against ServiceM8 so staff instantly see who's calling. The whole thing should run on infrastructure Phill controls (Cloudflare), not a third-party call-center SaaS. This is a greenfield build — nothing existed beforehand (confirmed by exploration: only unrelated social-media-content files in the Claude working directory).

Cloudflare has no native PSTN termination, so a telephony provider supplies the real phone number and call legs; Cloudflare (Workers, Durable Objects, D1, R2, Workers AI) supplies all the orchestration, state, storage, transcription, and the admin dashboard. This keeps "the brain" of the system entirely on Cloudflare.

**Provider correction (2026-08-08):** the original design chose Telnyx, but Telnyx's self-service number search returned no Australian numbers at all when actually tried — confirmed by Phill directly, contradicting Telnyx's own marketing pages. Verified against Twilio's console docs, Twilio's self-service number search **does** support buying Australian (+61) local numbers directly (same regulatory requirement as Telnyx: an AU address for local numbers). **The provider is now Twilio**, and every Telnyx-specific detail below has been superseded by the Twilio equivalents in the Key Decisions and Component Breakdown sections.

## Architecture at a Glance

```
PSTN caller
   → Telnyx DID (AU number)
       → webhook → Cloudflare Worker (/webhooks/telnyx)
           → routes event to a Durable Object: CallSession (one per active call)
               → runs the IVR state machine, returns TwiML (greeting/menu/DTMF-gather) synchronously in the webhook response
               → dials staff mobiles one at a time via nested `<Dial>` + `action`-callback chaining (answering-machine detection per attempt), bridges on human answer
               → holds the live audio WebSocket (Twilio `<Start><Stream>` media fork) → transcription pipeline → transcript segments
               → looks up caller number in D1 (servicem8_contacts, kept fresh by a scheduled sync from ServiceM8's REST API)
               → registers with a second Durable Object: CallHub (one global instance)
                   → CallHub relays live transcript + call-state updates over WebSocket to the Admin Dashboard
               → also accepts a direct "listen-in" WebSocket from the dashboard, relaying the raw call audio to an admin who clicks Listen on that call (via Twilio `<Connect><Stream>` bidirectional streaming)
   → on hangup: Twilio's dual-channel `<Dial record="record-from-answer-dual">` recording is fetched (via `recordingStatusCallback`) and stored in R2; final call record written to D1
Admin Dashboard (behind Cloudflare Access) — live calls view (transcript + listen-in), call history + playback, ServiceM8 match, settings (hours, staff ring list, admin users)
```

## Key Decisions

- **Telephony provider: Twilio Programmable Voice** (switched from an initial Telnyx choice — Telnyx's self-service portal returned no purchasable Australian numbers when actually tried, despite marketing pages listing AU coverage; Twilio's console confirmed to support buying AU local numbers directly). Twilio's model is **synchronous**: each webhook (initial call, DTMF-gather completion, dial-status callback) expects a TwiML XML document back in the HTTP response body, not an async REST command queue — the Worker's `CallSession` Durable Object renders the IVR state machine's commands directly into TwiML rather than issuing separate REST calls.
- **Number type: Twilio toll-free (1300/1800), not a local (+61) geographic number.** Twilio requires a personal photo-ID upload from an authorized representative to activate a local AU number; toll-free AU numbers require no supporting documents at all (business name/address/ABN only) — Phill preferred not to upload personal ID, and this avoids it entirely without changing anything else (same Twilio API, same webhook/TwiML code either way).
- **Existing business number:** forwarded, not ported. The forward is configured **with TCB's current phone provider** (whoever carries the existing number today), pointed at the new Twilio number — this is the opposite direction from a Twilio-side setting, and needs Phill to identify that current carrier before the cutover phase.
- **Recording:** `<Dial record="record-from-answer-dual">` on the bridging `<Dial>` verb captures the whole bridged conversation as one dual-channel recording; its `recordingStatusCallback` webhook delivers `RecordingUrl` once ready, fetched and re-uploaded to R2. The separate live-audio WebSocket feed (`<Start><Stream>`, one-way) is used only for transcription/listen-in — we don't reconstruct recordings ourselves from raw RTP.
- **Live transcription** — see **Addendum: Transcription Approach (Revised)** below; this replaces the original "nova-3 via `env.AI.run()`" assumption with a verified-working design.
- **ServiceM8 integration is sync-based, not a live per-call query.** A scheduled Worker pulls contacts from ServiceM8's REST API (a real API key, generated by Phill in ServiceM8 — separate from the MCP connection used during design, which is dev-only) into a D1 lookup table every 15–30 min. Calls look up the caller's number against that local table (sub-millisecond, no external call during ringing). New job/note creation back into ServiceM8 is an explicit admin button click, never automatic.
- **Business hours are admin-configurable**, not hardcoded — stored in D1, editable from a dashboard Settings page (time pickers per day), read by the IVR state machine to choose the after-hours branch.
- **Recording retention: 60 days**, enforced by an R2 lifecycle rule that auto-deletes objects under the dated `recordings/` prefix older than 60 days.
- **Dashboard auth: Cloudflare Access**, not custom auth — right-sized for 1–3 staff. A separate `staff_users` D1 table tracks per-person **role** (admin vs staff) for actions Access alone can't gate (Settings page, listen-in, ServiceM8 job creation); Phill's email (`phill@tcbpestcontrolcanberra.com.au`) is seeded as the first admin.
- **Live listen-in:** admins can open a real-time audio feed of any active call from the dashboard (monitor-only — no whisper/barge-in). This reuses the same Telnyx media-fork audio already flowing into `CallSession`; the DO relays those raw audio frames to any connected listen-in socket, and the browser decodes/plays them. Already covered by the call's recording-disclosure notice — no separate consent flow needed.

## Component Breakdown

| Responsibility | Cloudflare primitive | Notes |
|---|---|---|
| Twilio webhook intake, signature verification, event routing | Worker route `/webhooks/twilio` (single endpoint reused as the `action` URL for every verb) | Verifies Twilio's `X-Twilio-Signature` header (HMAC-SHA1 over the request URL + sorted-and-concatenated POST params, keyed by the Auth Token); dispatches to the matching `CallSession` DO by `CallSid` |
| Per-call IVR/ring/bridge state + live audio | **Durable Object `CallSession`** (one per active call) | Owns IVR state, DTMF, staff-ring progress, media-fork WebSocket, transcript buffer, ServiceM8 match; renders TwiML synchronously per webhook; persists to D1 on each transition |
| Active-call registry + dashboard fan-out | **Durable Object `CallHub`** (single global instance) | `CallSession`s register/deregister on start/end; relays transcript deltas and call-state to all connected dashboard sockets |
| Reverse-phone lookup cache | D1 table `servicem8_contacts`, populated by a cron Worker | Normalizes AU numbers to E.164 on sync |
| Call log / transcript / event history | D1 tables `calls`, `call_transcript_segments`, `call_events` | Written by `CallSession` as the call progresses and on hangup |
| Configurable settings (business hours, staff ring list) | D1 table `settings` | Edited via dashboard Settings page |
| Recording storage | R2, `recordings/{yyyy}/{mm}/{dd}/{call_id}.mp3`, 60-day lifecycle rule | Populated from Twilio's `recordingStatusCallback` webhook |
| Live transcript inference | See Addendum below | Invoked inside `CallSession` as audio frames arrive |
| Dashboard auth + roles | Cloudflare Access (self-hosted app) + D1 table `staff_users` | Access gates login; `staff_users` (email, role) gates admin-only actions. Phill seeded as admin |
| Live listen-in audio relay | Worker route `/api/calls/:id/listen` (WebSocket) → `CallSession` DO | Relays raw Twilio `<Start><Stream>` media-fork audio frames (mulaw 8kHz, base64) to a connected admin browser; browser decodes and plays via Web Audio API |
| Dashboard UI + API | Worker/Pages + `/api/calls` routes backed by D1 | Live view (WebSocket to `CallHub`, Listen button per call), history + playback (R2), Settings page |
| ServiceM8 sync + on-demand actions | Worker routes: cron sync + `/api/calls/:id/create-job` | Direct ServiceM8 REST API calls using a stored API key secret |

## IVR Flow (state machine, owned by `CallSession`)

1. **INCOMING** → check `settings.business_hours` against call time → **GREETING** or **AFTER_HOURS_GREETING**
2. **GREETING** → speak recording-disclosure notice ("this call may be recorded..."; the call is already answered implicitly by Twilio fetching this TwiML), start media-fork *as the notice plays* → **MAIN_MENU** (rendered in the same TwiML document — no separate webhook round-trip needed for "greeting finished")
3. **MAIN_MENU** → "1 = new booking/enquiry, 2 = existing job, 3 = urgent pest emergency, 0 = operator" (8s per attempt, 2 retries) → routes to **ROUTE_STAFF** tagged accordingly, or **VOICEMAIL** after repeated timeout/invalid input
4. **AFTER_HOURS_GREETING/MENU** → after-hours notice, "1 = emergency" routes to on-call number only, otherwise → **VOICEMAIL**
5. **ROUTE_STAFF** → dial staff numbers from the ring list one at a time via chained `<Dial><Number machineDetection="...">` + `action`-callback (each attempt's `DialCallStatus`/`AnsweredBy` decides whether to bridge or try the next number; emergency tag reorders on-call first) → bridge on human answer (**BRIDGED**) → next number on machine/no-answer → **VOICEMAIL** once the list is exhausted
6. **BRIDGED** → recording (`<Dial record="record-from-answer-dual">`) /transcription continue unchanged through the bridge → **WRAP_UP** on hangup
7. **VOICEMAIL** → prompt + record message → **WRAP_UP**
8. **WRAP_UP** → stop transcription session, finalize `calls` row, deregister from `CallHub`; recording upload to R2 happens asynchronously when Twilio's `recordingStatusCallback` webhook arrives

## Build Phases

0. **Foundations** — `wrangler.jsonc`, empty Worker router, D1 migrations, R2 bucket.
1. **Twilio basic voice webhook + TwiML** — Twilio account + AU number, webhook signature verification, minimal `<Say>`/`<Hangup>` TwiML response.
2. **IVR menu via `CallSession` DO** — DTMF `<Gather>`, full menu state machine, business-hours branch read from `settings`.
3. **Staff ring + AMD + bridging + voicemail** — chained `<Dial>`/`action`-callback dial-list, answering-machine detection, bridge, voicemail fallback.
4. **Recording to R2** — handle Twilio's `recordingStatusCallback`, upload to R2, link in `calls` row, 60-day lifecycle rule.
5. **Live transcription + listen-in** — `<Start><Stream>`/`<Connect><Stream>` media-fork WebSocket, transcription pipeline (see addendum), `CallHub` relay, D1 persistence, `/api/calls/:id/listen` route.
6. **Admin dashboard** — live calls view (transcript panel + Listen button), call history + playback, Settings page, behind Cloudflare Access, Phill seeded as admin.
7. **ServiceM8 integration** — REST client, cron sync into `servicem8_contacts`, caller-match display, "create job/note" action.
8. **Cutover + hardening** — forward TCB's current carrier number to the new Twilio number, load-test overlapping calls, confirm after-hours boundary and disclosure wording with the business.

Each phase is intended to become its own implementation plan under `docs/superpowers/plans/`, built and verified in order.

## Addendum: Transcription Approach (Revised After Technical Research)

The original design assumed Cloudflare's Deepgram `nova-3` model could be called for streaming transcription via the simple `env.AI.run()` Workers AI binding. Verification against current Cloudflare docs and the live `cloudflare/workers-sdk` repo found this is **not correct**:

- `env.AI.run("@cf/deepgram/nova-3", { audio: { body, contentType } })` only supports **batch** transcription of a complete audio file — not streaming.
- True real-time/continuous STT with `nova-3` (or the WebSocket-only `@cf/deepgram/flux` model) requires opening a **separate outbound WebSocket** from the Worker/Durable Object to Cloudflare's AI Gateway realtime endpoint (`wss://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/workers-ai?model=@cf/deepgram/nova-3&encoding=linear16&sample_rate=16000&interim_results=true`), authenticated with a `cf-aig-authorization` header — a different mechanism entirely from the `AI` binding, and one that expects 16kHz linear PCM input (our Twilio media-stream audio arrives as 8kHz mulaw by default, so it would need decoding *and* upsampling first).
- `@cf/openai/whisper-large-v3-turbo` (batch, via `env.AI.run()`) is confirmed to accept `{ body, contentType }` or a base64 string — the same simple binding call, no separate connection/auth scheme, no resampling requirement beyond giving it a standard audio container.

**Revised decision:** ship live transcription using **chunked Whisper (`@cf/openai/whisper-large-v3-turbo`) via the standard `env.AI.run()` binding** as the primary, confirmed-working path — buffer ~5s of call audio in the `CallSession` DO (flushed via a DO **alarm**, not `setTimeout`, since Durable Objects can hibernate), wrap it in a minimal WAV container, run it through Whisper, and relay the resulting segment to `CallHub` same as before. This is still "live" in the sense the requirement needs (an admin watching the transcript update every few seconds during the call), fully Cloudflare-native, and doesn't require solving audio resampling or an unverified WebSocket message contract before delivering value.

The AI-Gateway `nova-3` realtime path remains a **documented future upgrade** (lower latency, likely better accuracy) once the batch pipeline is working and the team wants to invest in the extra audio-processing complexity — it is not part of the initial implementation plan for Phase 5.

## Risks / Open Items to Resolve Before or During Build

- **Phill needs to identify TCB's current phone carrier** to configure the forward at cutover (this is *not* a Twilio-side setting).
- **Phill needs to generate a ServiceM8 API key/OAuth credential** for production use (the MCP connection used during design is session-only, unusable by the deployed Worker).
- **Staff mobile numbers and ring order** (including which number is "on-call" for the after-hours emergency path) are needed as config data before the staff-ring phase.
- Rough monthly cost (Twilio minutes both legs + carrier diversion charges + Workers AI inference + R2/D1) is likely tens of dollars for this call volume, but get an actual Twilio quote before committing.
- AU call-recording consent law varies by state; the standard spoken notice is good practice but isn't a substitute for the business's own legal confirmation of wording.
- 8kHz phone audio transcription will be less accurate than typical STT benchmarks, especially for spoken phone numbers/addresses and outdoor background noise (yard/traffic) — treat the recording as source of truth, transcript as fast context.
- Answering-machine detection is probabilistic, and Twilio's synchronous AMD mode introduces several seconds of dead air for a human answerer while detection runs — the design uses `<Dial><Number>`'s default asynchronous AMD (connects immediately, reports `AnsweredBy` in the background) to avoid that dead air, at the cost of a brief risk of a few seconds of IVR audio leaking to a machine before the system reacts; timeouts/thresholds should be tuned against real test calls before relying on it for the emergency ring path.
- Twilio strongly recommends using an official SDK's request validator rather than a hand-rolled `X-Twilio-Signature` check, citing edge cases (empty params dropped by some frameworks, proxy/SSL termination altering the URL) that commonly break custom implementations — the Worker's hand-rolled Web Crypto version (no Node SDK available in the Workers runtime) should be tested against real Twilio traffic early, not just synthetic test vectors.

## Verification Approach

Each phase has its own testable deliverable using real test calls to the Twilio number (or a test number before the real AU number is verified). End-to-end verification at the cutover phase: place live calls from an external phone to TCB's existing number, confirm the call reaches the IVR, routes correctly, bridges to a staff mobile, appears live in the dashboard with a live transcript, and produces a correct D1 record + R2 recording afterward — for both a known ServiceM8 contact and an unknown number, and for both in-hours and after-hours timing.

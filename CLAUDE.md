# phone-system (tcb-voip)

VOIP phone system for TCB Pest Control Canberra: Twilio IVR call routing, SMS + Facebook
Messenger inbox, call history, a staff admin dashboard, and an Expo mobile softphone.

**Read this first, then read the doc that matches your task** — the specs and runbooks below carry
the decisions and the hard-won gotchas. Do not rediscover them.

## Where the knowledge lives

`docs/superpowers/` is the project's memory. Nothing here is decorative.

- **`specs/`** — approved designs. Read the relevant one *before* implementing.
  - `2026-08-31-tenancy-foundation-design.md` — multi-tenancy, and the 7 sub-project roadmap to
    selling this to other businesses. **Shelved — not being pursued.** Kept for reference only; do
    not resume without Phill explicitly asking for it again.
  - `2026-08-27-tcbvoip-migration-design.md`, `2026-08-15-tcb-email-password-auth-design.md`,
    `2026-08-19-ios-softphone-phase1-design.md`, `2026-08-16-mobile-app-design.md` (+ phase2),
    `2026-08-27-settings-functional-design.md`
  - `2026-08-28-appstore-listing.md` / `2026-08-28-playstore-listing.md` — store listing copy,
    demo credentials, review notes, known review risks.
- **`plans/`** — task-by-task implementation plans, checkbox-tracked.
- **`runbooks/`** — the mechanical procedures, none of which run from CI here:
  - `android-play-submit.md` — build + `eas submit` to the Play internal track
  - `mobile-eas-first-build.md` — first EAS build setup
  - `auth-cutover.md` — moving staff onto email/password auth

## Layout

- `src/worker.ts` — Cloudflare Worker entry point; `src/{api,db,dial,ivr,twilio,facebook,push,
  email,access,html,durable-objects}/`
- `migrations/` — D1 SQL migrations, sequentially numbered
- `mobile/` — Expo app (TCB Phone). **Has its own `AGENTS.md` — read it before touching mobile.**
- `desktop/` — Electron wrapper
- `test/` — Vitest, via `@cloudflare/vitest-pool-workers`

## Commands

```bash
npm run dev          # wrangler dev
npm test             # vitest run
npm run typecheck    # tsc --noEmit  (never pipe into head — a pipe swallows the exit code)
npm run deploy       # wrangler deploy
```

Deploys also run from `.github/workflows/deploy.yml` on push to `master` or manual dispatch.
That is the only workflow — **pull requests do not run CI in this repo**, so a PR with no checks
is normal, not broken.

## Standing constraints

- **Expo is pinned to SDK 54 on purpose.** Do not upgrade without a plan for how Phill runs it.
  The reason is in `mobile/AGENTS.md`.
- **Never commit credentials.** `mobile/credentials/`, `play-service-account*.json`, `*.keystore`,
  `*.jks`, `.dev.vars` are all gitignored and must stay that way.
- **Store identifiers are permanent.** The Android package name and the iOS bundle ID
  (`au.com.tcbpestcontrolcanberra.tcbphone`) can never be changed or reused, and Play version
  codes can never be reused.
- **Tenancy is fail-closed.** `tenant_id` columns are `TEXT NOT NULL DEFAULT ''` deliberately;
  never default them to a real tenant. The existing business is `tnt_tcb`, hardcoded only in
  migration `0026`.
- **Check `ls migrations/` before adding one** — another session may have taken the next number.
- `AUTH_MODE=dev` bypasses staff login. Local development only, never in production.

## Current status (update this when it changes)

- **iOS:** TestFlight external testing was **rejected under Guideline 2.2** — TestFlight is for
  apps bound for public distribution, and this is a single-business staff tool. A public App Store
  submission would hit **Guideline 3.2 (Business)** for the same underlying reason.
  Staff distribution is **internal** TestFlight testers, who skip Beta App Review entirely (builds
  expire after 90 days, so re-upload quarterly). The durable alternative is an Apple Business
  Manager custom app, but note that choice is one-way per app record and tenancy sub-project 7 is a
  public App Store submission — so do not set this bundle ID to Private if it is meant to become
  the public product.
- **Android:** ships to the Play **internal** track via `eas submit`.
- **Backend:** single-tenant, TCB-only. The multi-tenancy plan is shelved (see `specs/` note above)
  — this stays a TCB-specific tool for now.
- **Numbers:** `+61866108941` (au1, main line) and `+61485034869` (us1, SMS + voice). The Canberra
  landline **`+61261059771` ("6105 9771") ported in on 2026-09-03** and is now the default caller
  ID. Setting one up is two separate steps: the Twilio console webhooks (from `/admin/webhooks` —
  the `?whsec=` IS the auth) and a `phone_numbers` row on `/admin/settings`. The app never touches
  Twilio's number-provisioning API, so adding the row configures nothing on Twilio's side, and
  inbound routing never reads that table.
- **A voice number must be homed in au1.** A Twilio number is global but its config is per-region,
  and inbound calls are processed in whichever region its Inbound Processing Region (`voice_region`)
  names — where, if no voice handler is set, Twilio rejects the call at the network edge: no call
  log, no webhook, and the caller hears a carrier "not connected" intercept. That is exactly how the
  ported landline lost a day: it arrived on **us1**. It has to be au1 specifically, because
  softphone clients register in au1 and Twilio only connects an SDK client to calls processed in its
  own region — and `src/twilio/restClient.ts` hardcodes `api.sydney.au1.twilio.com` besides. Fix it
  in the console (the number's **Regional** tab) or via
  `POST routes.twilio.com/v2/PhoneNumbers/<e164>` with `VoiceRegion=au1`; a 404 on the GET means no
  explicit config, which defaults to us1. `/admin/settings` records the region per number and warns
  when a voice number is not au1. **Unchecked:** `+61485034869` is `us1` with `voice_enabled=1` and
  has never taken an inbound call.
- **Ring-my-mobile is a DIVERT**, decided 2026-09-02: when a staff member enables it, their leg
  becomes their mobile and their softphone is **not** rung. Per-person — other staff still ring.
  This deliberately supersedes the "additive / also ring" wording in
  `specs/2026-08-27-settings-functional-design.md`; read the Superseded note there before "fixing"
  it back. Each on-shift person contributes exactly one leg, which is also what keeps
  `ring_priority` ordering meaningful under the cascade strategy.
- **AMD must stay async.** The pstn mobile leg dials with `AsyncAmd=true`; Twilio's default is
  synchronous and *blocks the call*, so the caller keeps hearing ringback for 2-4s after staff
  answer. The verdict therefore lands after bridging, and the machine case undoes a live bridge —
  redirect the caller out FIRST, then hang up the voicemail leg (a test asserts that order).
- **The queue hold document is a POLL, not just audio.** A caller in the ring queue can only be
  released (`<Leave/>` -> no-answer branch) when the hold document ENDS and Twilio re-fetches the
  waitUrl / fires its `<Gather>` action. So a `<Play loop="0">` in there (TwiML for "repeat until
  hangup") makes the release unreachable: the ring plan correctly goes `DONE{no_answer}` and the
  caller still hears ringback until they give up. That shipped in `9dabdd8` and stranded live
  callers on 2026-09-04; fixed in #45 with a finite `HOLD_RINGBACK_LOOPS` plus a regression test.
  The conference ringback is a different case — there the caller is released by the conference
  join, not by a poll — so its unbounded loop is correct. Never make the hold document infinite.
- **Recent work (2026-09-02/03):** the divert above (#26), async AMD (#27), recording playback —
  `calls.recording_duration` persisted from Twilio plus a proxy that always sends `Content-Length`
  and honours Range (#26) — and a sending-number dropdown in the mobile app (#28, OTA 34).
  Then in-page message composing and contact saving on web (#31) and mobile (#33), the Android
  compose-field fix plus a manual-dispatch **Publish OTA** workflow (#34), and #35: a region field
  on `/admin/settings` numbers, contact search in the web composer's To field, and a tappable
  contact name in mobile threads (OTA 37). Before that: ServiceM8 call logging (`src/servicem8/`),
  mobile reconnect-loop fix, and Facebook Messenger delivery-status tracking.
- **Known-unresolved:** the mobile in-call screen once showed **no hang-up button** (call answered,
  UI popped). Never reproduced; the paths now log and surface errors instead of silently stranding
  a live call. `reviewer@tcbpestcontrolcanberra.com.au` is a demo account sitting in the live ring
  roster marked `available` — only a stale heartbeat keeps it from ringing.

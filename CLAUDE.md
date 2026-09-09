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
  when a voice number is not au1. `+61485034869` is `us1` but its `voice_enabled` is **0** (checked
  against live D1 on 2026-09-06), so it takes no inbound calls and the region trap cannot bite it.
  Re-check its region before ever turning voice back on.
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
- **Recent work (2026-09-04/06):** the hold-queue release fix (#45, see the hold-document note
  above), an IVR **callback node** so a menu key logs a callback request (#46), an Australian
  ringback tone (#47), a Settings **connection test** for call quality (#48), then the CallKit
  native-answer chain — #49 (accepting a non-pending `CallInvite` aborts the process), #50 (adopt
  the `Call` on `CallInvite.Event.Accepted`) and #51 (hand that adopted call back, or the ringing
  screen pops an empty stack and goes black over a live call). Then #52: the mobile **Inbox** tab
  (Voicemail | Callbacks segmented, replacing the Voicemail tab), `PUT /api/callback-requests/:id`
  to mark one handled or reopen it, migration 0030's `done_at`/`done_by`, a `notif_callback` push,
  and the same mark-done actions on `/admin/callbacks`. OTA 45. Then the mobile **Admin** section
  (Settings > Administration, admin role only): business hours, call blocklist, phone numbers with
  the au1 region warning, and staff (working hours, ring order, availability, invite/reset/remove).
  It reads `GET /api/admin/staff` — a new admin-only endpoint, because the plain roster
  (`/api/staff`) deliberately omits schedules, ring order and password state so the softphone's
  transfer picker can stay ungated. Everything under `/api/admin/` is admin-only by construction.
  The IVR editor and Analytics stay web-only. OTA 46.
- **ServiceM8 needs `SERVICEM8_API_KEY` set as a worker secret, and nothing tells you if it isn't.**
  `deploy.yml` does not set it — wrangler secrets are separate (`npx wrangler secret put
  SERVICEM8_API_KEY`). Both halves of the integration (the job diary note and the auto-created
  contact) are gated on that one env var and used to fail in total silence, which is how it sat
  inert while callers who ARE in ServiceM8 kept landing as bare numbers. Checked 2026-09-06: no
  "Logged automatically by TCB Phone" note on any job, no contact created since 09-04. The paths
  now log `SERVICEM8_DISABLED` (no key), `SERVICEM8_SEARCH_FAILED` (missing/revoked key — a 401
  looks identical to no key), `SERVICEM8_NO_MATCH`, `SERVICEM8_NO_NAME` and
  `SERVICEM8_CONTACT_CREATED`, so `wrangler tail | grep SERVICEM8_` answers "is it on?".
- **ServiceM8 runs 3 minutes AFTER a call ends, on a cron — not from the status webhook.** Staff
  routinely create the ServiceM8 client or job during the call or right after hanging up, so firing
  the instant it ended searched for a record that did not exist yet, found nothing, and never tried
  again — the note and the contact were both lost for that call. The status webhook now only leaves
  `calls.servicem8_synced_at` NULL (migration `0031`) and `src/servicem8/syncQueue.ts` sweeps on the
  cron. A **second cron, `* * * * *`, exists solely for this sweep** — the `*/5` tick would have
  stretched "3 minutes" to 3–8; `scheduled()` branches on `event.cron` so everything else stays on
  `*/5`. Each call is CLAIMED in D1 before any work, because two overlapping ticks would otherwise
  post the diary note twice. The sweep reaches back only 2 hours, which is what stops the first tick
  after a deploy noting every call in history, and also bounds retries.
- **ServiceM8 search tokenizes; its OData filters do not.** `search.json?q=` matches a number
  however it is stored ("0402 430 107" matches a query of "0402430107"), but
  `jobcontact.json?$filter=mobile eq '...'` is an exact string compare, so the old name lookup
  missed every customer whose number carries spaces. The name now comes from the search results
  themselves — the `company` result's `name` IS the customer — with jobcontact only as a fallback,
  widened to several stored formats. One search per call now serves both the note and the contact.
- **Admin > Health Checks (mobile) is where "is it actually working?" gets answered.**
  `GET /api/admin/diagnostics` runs six checks, each one added because it failed silently in
  production: Twilio credentials, **live** voice-number regions (asks `routes.twilio.com` rather
  than trusting the region recorded on `/admin/settings` — a 404 there means no explicit config,
  which defaults to us1), who is on call right now, ServiceM8 (distinguishing "no key" from "key
  rejected"), the email binding, and the caller's registered push devices. `POST
  /api/admin/test-push` and `/api/admin/test-email` are end-to-end and deliberately target only the
  CALLER's own account, so a test never pages the team; the push one prunes any token Expo reports
  as `DeviceNotRegistered`.
- **"Call via my mobile" is the OUTBOUND counterpart to ring-my-mobile, and is a separate toggle.**
  `POST /api/softphone/call-via-mobile` asks Twilio to ring the staff member's mobile, and
  `/twiml/mobile-bridge` dials the customer once they answer, with the business number as caller ID
  on both legs. No VoIP leg exists, so the **native dialler owns the call** — mute, speaker, keypad
  and hangup come free, and there is deliberately no in-call screen. The trade is no in-app
  hold/transfer/notes mid-call. AMD on the staff leg is **synchronous here** — the exact opposite of
  the inbound pstn leg, and not a mistake: no caller is waiting yet, so blocking for the verdict is
  what lets us hang up instead of connecting a customer to someone's voicemail greeting. The row is
  keyed on the mobile leg's CallSid so history, the status webhook, recording and the ServiceM8
  sweep all treat it as an ordinary outbound call.
- **Recent work (2026-09-07/08):** call-via-mobile carried `<Dial action="…/webhooks/twilio/status">`
  and a `<Dial action>` URL must answer with TwiML — that endpoint is a status callback answering
  the plain text `ok`, so Twilio played "an application error has occurred" on **every** such call
  (#60). Then the **crash-loop day**: with no crash logs available anywhere (TestFlight needs an App
  Store Connect API key that is not configured, and Play's Developer Reporting API is disabled on
  the project), the only move was rolling the OTA back to #49 — so #61 added crash reporting the app
  had never had. Reports are written to the device FIRST and sent on the NEXT launch, because a
  fatal error kills the app before an HTTP request finishes; `occurred_at` and `received_at` are
  separate columns so the gap between them identifies a crash that really took the app down. A
  global handler chains to the previous one (observes, does not change behaviour) and an error
  boundary keeps a render error from unmounting the tree. Migration `0033`, read at `/admin/errors`
  (admin-only), reported to `POST /api/client-errors` (any signed-in staff — a handset that is
  falling over must be able to say so whoever holds it). Handsets are on **OTA 53**.
- **`OTA_BUILD` lives in `mobile/src/lib/build.ts`**, not in the Settings screen — a crash report and
  the Settings screen have to quote the same constant. `publish-ota.yml` greps that file for it, so
  moving it again means moving the grep in the same commit or every publish fails at "Read
  OTA_BUILD".
- **A voicemail is a call with a `mailbox_label`, NOT one with a transcript.** The mobile Inbox
  filtered on `transcription`, so every message Whisper produced nothing for was invisible — which
  is most short ones; both voicemails left on 2026-09-08 (4s and 5s) had `transcribe_attempts`
  exhausted at 3 and `transcription` NULL while sitting playable in D1. `mailbox_label` is written
  only by the voicemail path (`CallSession.ts`, beside the `voicemail_left` event); every recording
  in production without one carries an `answered` event, i.e. is a recorded conversation. Fixed in
  #61; `/admin/voicemail` (added in #60, restyled in #62) uses the same rule.
- **`cancelStaff` must never throw, and the answer path is why.** On answer the handler cancels the
  other ringing legs and THEN redirects the caller into the conference. Twilio's `Status=canceled`
  only applies to a leg still queued or ringing — a sibling that just hit voicemail, was declined,
  or answered a fraction earlier returns 400, one already torn down returns 404 — and that loop had
  no try/catch, so one ordinary race aborted the whole handler: every leg after it kept ringing, no
  `answered` event was written, and **the caller was never bridged**. Reported as "Android rings
  after the call is answered"; production showed three inbound calls with two ring rounds, no
  `answered` and only one `no_answer`. `cancelStaff` now swallows and logs `CANCEL_STAFF_FAILED`
  (#63). Keep the tolerance inside it, not at the four call sites — two already had it and two did
  not.
- **Call History was removed from the web dashboard (#63).** The handset carries the same list. The
  per-call DETAIL page `/admin/calls/:id` stays — `/admin/voicemail` links into it — but
  `/admin/calls` 404s deliberately, and a test pins that.
- **Known-unresolved:** the mobile in-call screen once showed **no hang-up button** (call answered,
  UI popped). Never reproduced; the paths now log and surface errors instead of silently stranding
  a live call. The iOS **crash loop of 2026-09-07** (app died within a minute of tab mount, over and
  over) was never root-caused either: it was escaped by rolling the OTA back to #49, and #53 carries
  the same code plus crash reporting and has been clean since. If it returns, `/admin/errors` is now
  the first place to look rather than the last.
- `reviewer@tcbpestcontrolcanberra.com.au` is a demo account that sits in the staff table marked
  `available`, but it is **excluded by code, not by luck**: `DEMO_ACCOUNT_EMAILS` in
  `wrangler.jsonc` feeds `demoEmails(env)` into `resolveRingTargets`, which drops it from the roster
  before shift or availability is even considered (and out of `/api/staff` likewise). An earlier
  note here claimed only a stale heartbeat kept it from ringing; that was wrong. Emptying that var
  is what would make it ring.

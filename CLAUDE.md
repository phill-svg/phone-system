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
- **`runbooks/`** — the mechanical procedures:
  - `android-play-submit.md` — build + `eas submit` to the Play internal track (needs a machine
    signed in to Play and EAS; not automated here)
  - `mobile-eas-first-build.md` — first EAS build setup
  - `auth-cutover.md` — moving staff onto email/password auth
  **iOS submission is the exception and runs on EAS**, not here:
  `mobile/.eas/workflows/submit-ios.yml` uploads a finished build to TestFlight from the EAS
  dashboard, because there is no Mac in this business and often no terminal in reach. It runs on
  EAS's infrastructure with the App Store Connect API key **EAS itself holds**, so it needs nothing
  locally — no `.p8` on disk, no key in a CI secret. **`eas.json` must NOT name `ascApiKeyPath`**:
  it pointed at `./credentials/AuthKey_*.p8`, correctly gitignored and therefore present on no
  builder anywhere, and every CI submit died at `Prepare credentials` with `eas-cli failed to
  resolve submission config`. Only `ascAppId` belongs there — the app record, not a credential.
  The key itself is stored once with `npx eas credentials --platform ios` → production →
  *App Store Connect: Manage your API Key* → *Set up your project to use an API Key for EAS
  Submit*; EAS **creates** it from an Apple login, so a lost `.p8` is never a dead end (Apple only
  forbids re-DOWNLOADING one). Until that existed the failure read `App Store Connect API Keys
  cannot be set up in --non-interactive mode`, which is only legible because the job sets
  `EXPO_DEBUG: '1'` — leave that on. First green submit: build 5, 2026-09-10.
  Do NOT rebuild this as a GitHub Actions job: one was written on 2026-09-10 and deleted the same
  hour, because `.eas/workflows/` already existed (`publish-update.yml`) and EAS holding the
  credentials is strictly less to go wrong than a `.p8` pasted into a repository secret.

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
`publish-ota.yml` is **manual dispatch only**, from the Actions tab. Nothing runs on a pull
request: **pull requests do not run CI in this repo**, so a PR with no checks is normal, not
broken. Mobile release jobs also live on EAS, in `mobile/.eas/workflows/` — check BOTH places
before adding one, or you will duplicate a path that already works.

## Standing constraints

- **Expo is pinned to SDK 54 on purpose.** Do not upgrade without a plan for how Phill runs it.
  The reason is in `mobile/AGENTS.md`. Two things about that pin, established 2026-09-10 rather
  than assumed: **Expo Observe needs SDK 55+**, so it cannot be adopted without the upgrade — and
  it measures STARTUP PERFORMANCE, not crashes, so it would not have caught `0xBAADCA11` anyway.
  And the pin's stated rationale (Expo Go on the App Store only serves SDK 54, and Phill tests on a
  real iPhone without a paid Apple account) now looks **stale**: there is a paid account, a signed
  TestFlight build, and internal testers. Re-read `mobile/AGENTS.md` and check that reasoning still
  holds before anyone treats the pin as permanent — but treat the upgrade as real work with real
  risk, not a version bump.
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
  The IVR editor and Analytics stayed web-only at the time; the IVR is now on mobile too (see the
  phone-menu bullet below). OTA 46.
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
  falling over must be able to say so whoever holds it). Handsets are on **OTA 66**, and the first
  binary carrying the native CallKit fix is **build 5** (2026-09-10) — Settings shows both as
  `#66 · b5`.
- **Recent work (2026-09-09/10):** the day the missed calls were root-caused. `0xBAADCA11` turned
  out to be the iOS CallKit watchdog rather than any JavaScript fault (see the two bullets on it
  below — most of a day went into chasing it as a JS crash, which it can never be), the cure shipped
  natively as **build 5**, and the TestFlight submit that carries it was finally made to work from
  EAS with no Mac and no `.p8` anywhere. Then, in order: **#89** the after-hours **on-call
  rotation**, migration `0035`, editable on web `/admin/settings` and mobile
  `Admin > After-hours On Call`, with a Health Check for it; **#90** a back button on the mobile
  **Admin hub**, which had no way out at all, plus the missing `Icon` fallbacks on the on-call
  screen; **#91** the **phone menu on mobile** (`Admin > Phone Menu`) as a list of steps rather than
  the web's node canvas, reversing this file's old "IVR stays web-only" line — and the PR that
  actually added `iconFallback` to `Row`, which this line used to credit to #90; then **#92** and **#94**, two rounds of
  `/code-review` fixes over #89 — see the review bullet below, which is the durable lesson from the
  whole day. OTA **66** on both channels; worker deployed.
  **Still outstanding at the end of it, and almost none of it is code:**
  * Build 5 has never been proven on a device. It needs ONE locked-phone test call — lock the
    handset, leave it a few minutes so the launch is genuinely cold, then ring the business number.
  * **The on-call rotation is LIVE BUT EMPTY, and the IVR's after-hours branch is still not wired to
    it**, so after-hours callers still reach voicemail. Health Checks now names both gaps in one
    line rather than making you find them one at a time.
  * `staff_users` holds only Phill plus the demo reviewer account, so there is nobody to rotate
    between.
  * Speaker-labelled transcripts: the `GA...` service SID was being set up;
    **Dual-channel Recording for Conference** in the Twilio Console is the other half and cannot be
    checked from here. Read one real transcript afterwards and flip `transcript_staff_channel` if
    the labels come out reversed.
  * **A Twilio Auth Token was exposed in chat on 2026-09-10 and needs rotating** if it has not been.
    The ORDER matters: create a SECONDARY token in Twilio, update `TWILIO_AUTH_TOKEN` in the
    Cloudflare dashboard (Workers & Pages > tcb-voip > Settings > Variables and Secrets), make one
    test call in and out, and only then promote it. Killing the old token before the worker holds
    the new one stops every inbound call, because that value both validates Twilio's webhook
    signatures and authenticates our REST calls.
  * The **web** `/admin/settings` on-call section and the mobile screen are separate
    implementations of the same rota; a change to one usually needs the other.
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
- **Speaker-labelled call transcripts need TWO things set, and neither announces itself.**
  `TWILIO_INTELLIGENCE_SERVICE_SID` (a `GA...` Conversational Intelligence service) as a worker
  secret -- `deploy.yml` does not set it, wrangler secrets are separate -- AND **Dual-channel
  Recording for Conference** turned on in the Twilio Console (Voice > Settings). Without the secret
  nothing runs; without the toggle every recording comes back on one channel and is discarded
  unlabelled, because labelling a mono mix would be a guess presented as fact. Both states are
  reported by Admin > Health Checks, which is the answer to "is it on?" -- added precisely because
  `SERVICEM8_API_KEY` sat inert for a day with nothing saying so.
- **A mono recording never reached Health Checks, so the transcripts alarm could not fire.** Checked
  against live D1 on 2026-09-10 after "the transcripts isn't working": EVERY recorded call had
  `intelligence_sid` NULL — Twilio had never been asked, not once, since the feature shipped. The
  check counted rows `WHERE intelligence_sid IS NOT NULL`, but a recording that comes back mono is
  skipped in the recording webhook BEFORE Twilio is asked, so it never gets a sid. Its one
  `single_channel` branch — the headline case, the Console's dual-channel switch being off — was
  therefore unreachable from the webhook path and could only ever be set by the sweep, from a
  DUAL-channel recording whose sentences all landed on one channel. The screen instead said
  "Configured, but no answered call has been transcribed yet", indefinitely, which is the exact
  reassuring silence it was built to break. The skip is persisted as `single_channel` now and the
  check keys on `intelligence_status`.
  Two constraints on that marker. It is written **only for conference recordings**, flagged with
  `&conference=1` on the three callback URLs we build ourselves (`CallSession.handleAgentAnswer`,
  `/webhooks/twilio/transfer-answer`, `/twiml/voice-app`) — a call-via-mobile leg is
  `<Dial record="record-from-answer">`, mono by construction and unaffected by any Console setting,
  so marking those would pin the check red over something working exactly as designed. Inferring it
  from Twilio's own parameters was the alternative and is worse: `<Dial>`'s documented
  recordingStatusCallback carries no `ConferenceSid`, but that is a fact about their docs, not a
  guarantee. And the write is guarded on `intelligence_status IS NULL`, because callbacks are
  redelivered and a completed transcript must not be relabelled a misconfiguration by a late
  duplicate. Note `conf=` already means a conference NAME on `/webhooks/twilio/join-conference`;
  the boolean is deliberately spelled `conference`.
  **`TWILIO_INTELLIGENCE_SERVICE_SID` is bound in `vitest.config.ts`**, not `wrangler.jsonc` (the
  real one is a worker secret). Mutating the `env` imported from `cloudflare:test` does NOT reach
  `SELF.fetch` — the worker holds its own — so the first version of these tests passed every
  assertion with the branch never executing. A fifth instance of "a test that passes against
  reverted code is not a test". Any test whose subject is "the secret is ABSENT" must now say so
  explicitly rather than lean on the config default.
- **Twilio has TWO Conversation Intelligence products and this uses the OLD one.** Searching the
  Console lands you on the new one (Conversation Orchestrator: configurations, memory stores,
  profiles, a "grouping type" field) — none of which applies. `src/twilio/intelligence.ts` POSTs one
  recording to `intelligence.twilio.com/v2/Transcripts` with a `ServiceSid`, which is
  **Conversation Intelligence (classic)** → Services, and the SID starts `GA`. No Language Operators
  are needed; only the raw sentences and their channel numbers are read. Creating it by API avoids
  the navigation entirely: `POST https://intelligence.twilio.com/v2/Services` with `UniqueName`.
  Twilio's own docs confirm the channel rule this code's `transcript_staff_channel` default rests
  on: for a CONFERENCE, channel 1 is whoever joined first, and classic CI labels channel 1 "Agent"
  by default — our caller is redirected in first, hence the default of 2.
- **Which audio channel is the staff member is a SETTING, not a constant** (`transcript_staff_channel`,
  default 2). Twilio gives channel 1 to whoever joins the conference first, and `handleAgentAnswer`
  awaits the caller's `redirectCall` into `/join-conference` BEFORE returning the staff leg's
  `<Dial><Conference>` -- so the caller usually lands first. It is a race, not a rule: an earlier
  version hardcoded 1 on the opposite claim and would have labelled every inbound transcript
  backwards. Read one real transcript and flip the setting if the labels are the wrong way round.
- **Whisper and the Twilio sweep both write `call_transcript`, in the same cron tick.**
  `backfillTranscripts` can select a row with a NULL transcript, spend 10-30s in Workers AI, and land
  after the labelled text was written -- destroying it permanently, since the row is by then out of
  the sweep's query. `transcribeCallRecording` therefore guards its UPDATE on
  `intelligence_status <> 'completed'`. The guard belongs on the WRITE; the gap between read and
  write is where the race lives.
- **Outbound calls store the BUSINESS number in `caller_number`.** Both outbound paths bind it that
  way and the customer's number is `called_number`, so anything identifying "the customer" has to
  branch on `direction` -- reading `caller_number` unconditionally told Twilio the office landline
  was the customer.
- **`handleGetDiagnostics` positionally destructures its `Promise.all`.** Adding a check without
  adding a binding shifts every one after it and drops the last off the end silently. That happened
  when the transcripts check was added: the push check vanished while every other assertion still
  passed. A test now pins the exact key list.
- **Staff-leg caller ID comes from `phone_numbers`, and nothing validates those rows against
  Twilio.** `dialStaff` used `TWILIO_FROM_NUMBER` (the number this system was built on) and so
  ignored the ported landline entirely; it now resolves the default like every other outbound path,
  shape-checked against E.164 first. Without that check a typo'd default would 400 every leg, and
  every inbound call would fall to voicemail with no handset ringing.
- **A divert can ring showing the CUSTOMER's number, and that needs `CallToken`.** "I want to know
  who's calling before I answer": with `divert_caller_id` on (default, `/admin/settings` and mobile
  Admin > Diverted calls), the leg to a staff mobile presents the caller's number instead of the
  business one. Twilio rejects a `From` you don't own (error 21210) **unless** the inbound call's
  `CallToken` rides along to prove the leg is forwarding that call — and Twilio sends `CallToken`
  on a call's **first** webhook only, so `handleMainWebhook` stashes it in DO storage rather than
  reading it at ring time, several gather turns later. It is documented under SHAKEN/STIR, which is
  a **North American** scheme, so whether Australian carriers honour it is **unverified** — hence
  `dialStaff` retries once with the business number on a `TwilioApiError` and logs
  `DIVERT_CALLER_ID_REJECTED`. That fallback is not optional: without it a rejected caller ID
  throws, `dialBatch` cancels, and every inbound call falls to voicemail with no handset ringing.
  The retry is deliberately narrow: **HTTP 400 only** (see the caller-ID bullet below — it was
  briefly any non-429 4xx, which would have double-dialled every leg on a rotated API key). Those
  are the caller-ID rejections it exists for, where Twilio validated the request and created nothing.
  A 5xx, a 429, or a network error may have created the call before failing to say so, and
  re-dialling then leaves a second leg ringing that is in no `attemptSids` and so is never cancelled
  on answer — #63's symptom exactly.
  A withheld caller ID or a missing token logs `DIVERT_CALLER_ID_SKIPPED` and rings as the business.
- **The trade on that setting is the MISSED call, not the answered one — and it has two halves.**
  With it on, a missed divert sits in the phone's own call log looking like an ordinary unknown
  number rather than a work call; the app's Recents stays the authoritative missed-call list, and
  marks them red. The second half is worse and less obvious: **returning that call from the phone's
  own log dials the customer from the staff member's PERSONAL number.** The customer keeps it and
  rings it directly from then on, and the call creates no `calls` row, no recording, no ServiceM8
  diary note and never appears in Recents. Calling back from the app goes out as the business, as
  before. That pair is why this is a setting and not a constant.
- **`Admin > Health Checks` reports the divert caller ID**, because the fallback is invisible on
  purpose — the phone still rings, the call still connects, just from the business number. A
  rejection is persisted (`divert_caller_id_last_error`) rather than left in a log line nobody
  tails. What the check CANNOT see is a carrier that accepts the leg and then rewrites the presented
  number downstream, so it says "make one test divert" rather than claiming more than it knows.
- **The answered case is covered by a whisper, and it must precede the `<Dial>`.**
  `renderDialAgentIntoConference({ whisper: true })` prepends `<Say>T C B call.</Say>`, so a staff
  member seeing an unfamiliar number is told it is work before they speak. Letter-spaced because TTS
  reads "TCB" as a word. Inside the `<Dial>` the customer would hear it too (they are already in the
  conference — `handleAgentAnswer` redirects them in first); after it, it would never play. The flag
  travels as `whisper=1` on the agent-answer URL and is set **only** when the caller ID was actually
  swapped, so the softphone (whose screen already says who is calling) never gets it.
- **The conversation-undo token is a millisecond TIMESTAMP matched exactly, which constrains two
  things.** `handleDeleteThread` returns `deletedAt` as the client's undo token; `restoreThread`
  matches `deleted_at = ?`. So:
  (1) **Nothing may re-read the clock.** `softDeleteThread` used to call `Date.now()` a SECOND time
  to write the rows — a different reading across the await — so whenever the millisecond ticked
  between them the token was one behind the stored stamp, Undo matched nothing, and the conversation
  stayed hidden behind "Nothing to restore", recoverable only from D1. The stamp is passed in now
  (#69). It surfaced as a one-in-many CI failure on `deletions.test.ts` (deploy #75, a docs-only
  commit) — which is what a real race looks like before anyone calls it a flake. Both regression
  tests force the clock forward on every reading so they fail every run instead of occasionally.
  (2) **Nothing may mutate hidden rows behind it.** `markThreadRead` had no `deleted_at IS NULL`
  guard, so opening a deleted thread — still reachable by number from Recents and from a call detail
  — marked its hidden messages read, and the undo restored them with the unread state destroyed
  (#70).
  `THREAD_DELETED` logs `deletedAt` because it IS the token and the client's copy dies with the undo
  alert. Deliberately NOT changed: `softDeleteCall` reads its own clock too, but `restoreCall`
  matches on `id`, never on the stamp, so no drift is possible there.
- **Resolving the caller ID must never THROW on the ring path, and the rejection marker clears
  itself.** `dialBatch` resolves the business caller ID once per ring round rather than once per leg
  (four serial full-table reads in front of a caller on hold), which puts that call ABOVE its per-leg
  try/catch. Every `dialStaff` failure falls the caller through to business voicemail; a throw from
  `callerId()` instead escapes `dialBatch`, `startRing` and `handleMainWebhook` to the DO's catch-all,
  which says "we're experiencing a technical issue" and HANGS UP on a live customer — and via
  `performDeferredDial` does that to someone already on hold. So `callerId()` swallows a failed READ
  the same way it already handled an invalid VALUE, falling back to `TWILIO_FROM_NUMBER`
  (`CALLER_ID_LOOKUP_FAILED`). A test renames `phone_numbers` so the read genuinely throws; against
  the old code it fails with the technical-issue hangup.
  Two companions from the same review: `divert_caller_id_last_error` is cleared on the first
  successful divert of a call, because a marker that only ever gets set pins Health Checks red for
  seven days and teaches you to ignore it; and `isCallerIdRejection` is **HTTP 400 only**, since
  401/403 are auth (a rotated key would otherwise dial every divert leg twice for the length of the
  outage and be reported as a caller-ID fault), 404 is not-found, and 429/5xx may have created the
  call. Not an incident that happened — a hazard found by review before it could.
- **Removing a staff member is a MULTI-TABLE cleanup, and the handset is the part people forget.**
  `handleRemoveStaff` clears sessions, `password_tokens`, `login_attempts`, `push_tokens` and
  `user_settings` before deleting the row. `getPushTokensForType` selects every row in `push_tokens`
  and filters only on the owner having switched that notification type off — it never checks the
  owner still exists — so a missed delete leaves a departed person's phone showing inbound customer
  texts, sender name and first 240 characters, indefinitely, with nothing anywhere saying so. The
  `user_settings` row matters for the opposite reason: without it a re-invite silently restores the
  old mobile number and ring-my-mobile state onto whoever next holds that address.
- **"Was this call missed?" has ONE definition, and it is `answered`/`event_count`, not `ivr_path`.**
  `listCalls` ships both columns for this. The web softphone kept the older `!ivr_path` rule long
  after the handset moved (#65), and `CallSession` writes `ivr_path` on the voicemail handoff — so
  **no call that reached voicemail was ever marked missed on the web**, which is exactly the set
  that still needs ringing back. Both surfaces now answer it identically; change them together.
- **After-hours calls ring an ON-CALL rotation, which is a different question from "who is on
  shift".** Before this, the closed branch of `business_hours` went straight to the "after hours"
  voicemail node and every call outside business hours reached a machine — not a bug in the IVR but
  a consequence of `resolveRingTargets` only ever returning people who are on shift, which after
  hours is nobody, by construction. The `on_call` ring target names ONE person per week and
  deliberately bypasses **both** gates the other targets apply. The schedule is bypassed because
  that is the entire point. `status` is bypassed for a less obvious reason: `away`/`offline` is a
  live signal meant for the working day and it is STICKY, so someone who set Away at 4pm and went
  home still carries it at 11pm — honouring it would let one forgotten toggle silently disable the
  whole rota, caller hearing voicemail, nothing anywhere saying why. Being on call IS the commitment
  to be rung; the way out is to swap the week.
  It also **overrides ring-my-mobile** and always dials the personal mobile, which is the one place
  this system overrides a staff preference: the softphone leg depends on a backgrounded app being
  woken by a VoIP push, which is the weakest link at 2am and is exactly what iOS was killing on
  2026-09-10. No mobile saved falls back to the softphone rather than to nobody.
- **The rota does NOTHING until the IVR points at it, and as of 2026-09-10 it does not.** There is
  no `after_hours` flow in D1 at all (only `main`), and `main`'s closed branch is `n_7lrp841`, a
  voicemail node. The ring node has to be added on the closed branch with "Whoever is on call" as
  its target — web-only, `/admin/ivr/main`. The recommended shape is a `gather` first ("press 1 if
  this is urgent, otherwise leave a message") so routine after-hours enquiries still go to voicemail
  and the rota survives past a month.
- **Rotation weeks run Monday→Monday in Australia/Sydney, and the anchor MUST be a Monday.**
  `weekStartKey` resolves the Sydney calendar date FIRST and only then shifts back to Monday: read
  the UTC weekday first and Monday 09:00 in Canberra (Sunday 23:00 UTC) counts into the previous
  week and rings last week's tech — most of every Monday morning, not an edge case. The arithmetic
  afterwards runs in UTC on a bare calendar date so a 23-hour daylight-saving day cannot move a
  boundary. A non-Monday anchor would shift every boundary forever and is refused on write, as is a
  member who is not staff (a typo fails SILENTLY at 2am — the week comes round, nobody matches, the
  caller hears voicemail exactly as though no rota existed) and a duplicate (not an error at ring
  time, just two weeks in the cycle, which reads as a mysteriously unfair rota months later).
  A per-week OVERRIDE covers swaps and applies to that week only — it never shifts the rotation.
  Health Checks reports who is on call, a rotation member who has left, and a member with no mobile.
- **A completed password reset invalidates the account's OTHER tokens and its lockout.**
  `issueToken` always INSERTs, so two clicks of "Send reset" leave two live links; consuming one
  used to leave the other valid for the rest of its hour, and whoever held the older email could
  set the password again afterwards and take the account. `login_attempts` is cleared in the same
  place, or someone who hit the 8-failure lockout and then legitimately reset was still refused on
  the next login.
- **The client-side escapers must escape QUOTES.** `h()` in `ivrFlow.ts` and `esc()` in
  `messages.ts` are `textContent` → `innerHTML`, which handles `& < >` and **not** `"` or `'` — and
  their output is spliced into double-quoted attribute values. An admin-entered mailbox name with a
  quote could close the attribute and add an event handler running in the authenticated page. Both
  now replace the quote characters explicitly. Anything new that interpolates into an attribute
  belongs behind the same helper.
- **Admin pages render in `Australia/Sydney` via `formatSydney`, because Workers run UTC.** A bare
  `toLocaleString("en-AU")` showed a 9am Canberra call as 11pm the previous day, and a callback as
  though it came in last night. One helper in `src/html/formatTime.ts` for every SERVER-rendered
  admin time; do not inline the option bag again. Three places deliberately stay outside it: the
  clock code inside `phone.ts`'s template literal runs in the **browser**, which is already in
  Canberra, and `businessHours.ts` / `dateRules.ts` keep their own `TIME_ZONE` because theirs is a
  routing decision rather than a label — importing from `src/html/` would be the wrong direction.
- **An empty transcript result is NOT the same as a mono recording.** `fetchSentences` returns
  `null` for "could not read" (non-2xx, thrown fetch, past `MAX_SENTENCE_PAGES`) and an array only
  for a real read. They used to collapse into `[]`, and the sweep turns empty into the **terminal**
  `single_channel` — so a transient 502 abandoned a transcript Twilio still held, and Health Checks
  counted it as mono and told you to switch on a Console setting that was never off. `null` now
  leaves the row pending for the next tick — and **counts the attempt**, which is what bounds it:
  not all of these are transient (a transcript past the page cap fails identically every tick), and
  an uncounted retry would hold one of the five `BATCH` slots forever while the query, ordered
  `started_at DESC`, starves the older calls behind it. A read that genuinely returns nothing is its
  own terminal `no_speech` — someone rang and said nothing — so it is not reported as the Console
  switch either. Health Checks counts `abandoned`/`failed` too: turning the wrong alarm off without
  that would have traded it for no alarm, which is the exact silence that screen exists to break.
- **A recording-status callback may never blank a recording it does not carry.** All three of
  `recording_url`, `recording_sid` and `recording_duration` are COALESCEd, because a redelivery — or
  a `RecordingStatus` of absent/failed — arrives with no `RecordingUrl` and was writing NULL over a
  good one, after which `/api/calls/:id/recording` 404s for a call whose audio is fine in Twilio.
  COALESCE is only half of it: this is a **form post**, so a field Twilio has nothing to say about
  can arrive absent *or* empty, and `?? null` only catches the first — `""` is a value that survives
  COALESCE and blanks the column just as destructively. Hence `blankToNull` beside
  `parseRecordingDuration`, which has handled exactly this for the duration all along. It is
  **not** first-write-wins: two different recordings legitimately post under the same `callSid` (a
  divert into the staff member's carrier voicemail records the conference, then the caller falls to
  business voicemail and records again), and the later real one must win. A test pins both halves.
- **The web Away button has to POST.** It used to only highlight itself and focus the reason box, so
  the one status that means "stop ringing me" was the only one that changed nothing on the server —
  the dot went yellow and every inbound call still rang that leg. It persists now, and it opens the
  reason box **synchronously first**: `setStatus` awaits the PUT before it highlights, and
  highlighting is what un-hides the wrapper, so focusing after the call focuses a `display:none`
  input and does nothing.
  It also sends **no `awayReason` at all**, which is now different from sending `null`: absent means
  "I am not talking about the reason" and preserves a stored one, `null` clears it. That matters
  because `/api/staff` returns only `{email, role, status}` — it omits the rest deliberately so an
  ungated softphone cannot read the team's details — so the reason box always starts EMPTY however
  long a reason has been set, and sending its value would wipe the reason on every Away click. The
  handset relies on the same rule: `mobile/src/lib/api.ts` sends `{status}` only. Preserving is
  scoped to `away` — any other status clears the reason said or unsaid, so nobody is left available
  carrying a stale "On site until 3".
- **THREE reads on the ring path must never throw, and that list is the thing to check.** A throw
  inside `startRing` escapes `handleMainWebhook` to the DO's catch-all, which says "we're
  experiencing a technical issue" and **hangs up on a live customer** — via `performDeferredDial`, on
  someone already waiting on hold. `callerId()` was fixed for this (#71); `resolveRingTargets` sits
  one line away at `CallSession.ts:402` and had the same exposure twice over — `getStaffRoster`
  (which `JSON.parse`s every row's schedule) and a per-person `getUserSettings` read inside the loop.
  Both are guarded now (`RING_ROSTER_LOOKUP_FAILED`, `RING_PREFS_LOOKUP_FAILED`), and both fall
  **closed**: a failed preferences read rings that person's softphone, an unreadable roster returns
  zero legs, which the ring node already handles by continuing to `noAnswerNextNodeId` (voicemail).
  Catching `JSON.parse` throwing is not enough, either — a schedule column holding the literal text
  `null` parses fine and then throws in `isWithinBusinessHours`, so the SHAPE is checked with
  `isBusinessHoursSchedule`. The fourth member of this family is `playFromConfig`: a wait node with a
  blank `audioAssetId` (`""` survives `?? null`) throws in `resolveAudioCommands`, and one with both
  fields set throws in `renderHold`. The fifth is `resolveOnCallEmail` (two D1 reads plus a
  `JSON.parse` of the stored rotation), guarded the same way and falling back to "nobody on call",
  which the ring node already handles. **Anything new that reads or parses inside `startRing` joins
  this list.**
- **A Twilio status callback may not erase what an earlier one recorded.** Twilio's callbacks are
  **not ordered**, so a late `sent` landing after a `failed` used to overwrite the terminal status
  and NULL its `ErrorCode` — the message then read as fine in the app AND dropped out of
  `checkMessengerChannelHealth`'s count, quietening the outage alarm exactly when the outage was
  worst. `updateMessageStatus` now refuses a non-terminal status once a terminal one is stored and
  COALESCEs the error fields. Terminal-to-terminal is still allowed deliberately: ordering
  `delivered`/`failed`/`undelivered`/`read` against each other would invent a progression Twilio
  does not promise.
- **Sending a message is TWO failures, not one.** `insertMessage` used to sit inside the send `try`,
  so a D1 hiccup after Twilio returned a sid answered "Could not send" for a message the customer
  had already received: staff resend, the customer gets it twice, and with no row the status
  callback for that sid is a permanent no-op. The insert is its own try now
  (`MESSAGE_INSERT_FAILED`). Splitting it is also what made a 2xx carrying no `sid` a silent
  success, so that is explicitly a 502 — `sendSms` only throws on `!res.ok`.
- **One failed Messenger message is not an outage, and nobody to tell is not the same as telling
  them.** `checkMessengerChannelHealth` fired on a count of **one** — a single reply outside Meta's
  24-hour window — and then armed a six-hour cooldown, silencing a real channel break minutes later.
  Threshold is `CHANNEL_FAILURE_THRESHOLD`, and the cooldown is stamped only when a push actually
  went out. Relatedly, `fb_name_attempts` must not count a failure that is about the **token**
  rather than the person: a dead token (or a Graph 5xx/429) fails identically for every psid, and
  counting it burned `MAX_NAME_ATTEMPTS` on the whole backlog in six hours — after which those names
  can never be backfilled, because the manual refresh uses the same per-psid route. Graph code 100
  IS about the person and still counts.
- **A business-hours window is validated in ONE place, and a close of `00:00` means midnight.**
  `isWithinBusinessHours` is `minutes >= open && minutes < close`, and the two duplicate
  `isDayWindow` copies (`api/settings.ts`, `api/staff.ts`) checked only the `\d{2}:\d{2}` shape — so
  `09:00`–`00:00`, the natural way to write "until midnight", read as **closed all day**: every
  in-hours call routed to after-hours and that person dropped off the ring roster, while the
  schedule screen showed hours that look perfectly correct. One validator now, in
  `ivr/businessHours.ts`, requiring a real `HH:MM` and `close > open` — with `00:00` resolving to
  end-of-day in the matcher too, because rejecting it outright would make "until midnight"
  inexpressible, which is a worse fix than the bug. Tightening a validator can lock an admin out of
  saving an already-stored bad row, so **check live D1 before deploying one** (checked 2026-09-09:
  all clean).
- **A closed date the matcher cannot read is SKIPPED, so it is validated on write.** A mistyped
  holiday otherwise leaves the IVR open on the one day of the year it mattered, silently. Digit
  shape is not enough either — `"25-12"` and `"2026-13-01"` both match their regex and can never
  fire — so `isValidClosedDateEntry` checks a real month/day and refuses an inverted full-date
  range, and the error names the offending entry. `MM-DD..MM-DD` recurring ranges now work: they are
  compared against `MM-DD`, since against `YYYY-MM-DD` `"2026-12-27" <= "12-31"` is already false on
  the first character. One that wraps the new year is two ranges under string comparison.
- **`0xBAADCA11` is iOS killing the app for not answering a VoIP push fast enough, and it is the
  root cause of the "crash loops" (2026-09-10).** The device crash log — Settings > Privacy &
  Security > Analytics & Improvements > Analytics Data on the iPhone, which needs **no** App Store
  Connect key and is the way in every time TestFlight crash logs are unavailable — reads
  `EXC_CRASH/SIGKILL`, `termination namespace FRONTBOARD code 0xBAADCA11`, `procRole "Non UI"`,
  `isLocked 1`, launched 11:38:11 and killed 11:38:18. `0xBAADCA11` spells "bad call": it is the
  CallKit watchdog. A VoIP push launches the app in the **background** and iOS allows roughly
  **five seconds** to report the call to CallKit, or FrontBoard SIGKILLs the process.
  **No JS runs**, which is why `/admin/errors` stayed empty however hard it was searched — a JS
  crash reporter can never see this, and chasing it as a JavaScript bug wasted most of a day.
  The whole incoming-call → CallKit path is **native** (`reportNewIncomingCall` in
  `TwilioVoiceReactNative+CallKit.m`, no JS involved). The only thing gating it is that the
  `PKPushRegistry` is created by `initializePushRegistry()`, which the SDK exposes **only to JS** —
  its `expo-module.config.json` is `"platforms": ["android"]`, so nothing wires it up natively on
  iOS. It used to be called deep inside `registerForIncoming`, behind the bundle booting, auth,
  the tabs mounting, a permission check and a network round trip; `primePushRegistry()` now runs at
  module scope in the root layout instead (OTA 59). **That is a mitigation, not a cure** — the next
  bullet is the cure, and why moving the call earlier in JS could never have been enough here.
  Ruled out along the way, so do not re-check: `expo-updates` is not delaying launch
  (`launchWaitMs` defaults to 0 — it launches straight from cache), and no native module was added
  after the installed binary was built.
  **The business symptom is missed calls, not a crash anyone sees.** The 10:01 call on 2026-09-10
  rang twice and went to voicemail with `answered = 0`: the handset was not ignoring the customer,
  the handset was being killed. Any report of "it rang but nobody could answer" starts here.
- **The cure is `extraModulesForBridge:`, and the New Architecture is why it has to be.** Priming
  the registry earlier *in JS* can never be enough on this app: `newArchEnabled` defaults to true
  (and reanimated 4 requires it, so turning it off is not on the table), and under bridgeless React
  Native a legacy native module is built **lazily, the first time JS touches `NativeModules.X`**.
  `TwilioVoiceReactNative` is a legacy `RCTEventEmitter`, and it is the object that observes the
  push notification and calls `reportNewIncomingCall` — so on a cold launch from a VoIP push
  nothing is listening until Hermes has evaluated the bundle, whichever line of JS runs first.
  (Under the OLD architecture `RCTCxxBridge` eagerly builds every `requiresMainQueueSetup` module in
  parallel with loading JS, which is what makes this an architecture question rather than a
  code-ordering one.)
  The hook that runs earlier is `RCTTurboModuleManager`'s: it asks its delegate for modules the app
  has already built (`_legacyEagerlyInitializedModules`, populated from `extraModulesForBridge:`)
  and consults that **before** the `[moduleClass new]` fallback, while the React host starts and
  before the bundle loads. The chain is `RCTTurboModuleManager` → `RCTInstance` →
  `ExpoReactNativeFactory` → the app's own `ReactNativeDelegate`, each link forwarding only if the
  next `respondsToSelector:`. So `mobile/plugins/withTwilioEarlyInit.js` appends
  `TwilioEarlyInit.swift` to the generated `AppDelegate.swift`, which builds the module there and
  primes its push registry. Handing back **our** instance is also what avoids the second CallKit
  provider that makes the obvious version of this fix worse than the bug: React Native adopts it
  instead of constructing one of its own.
  **The method is added with `class_addMethod`, not written in Swift, and that is not a style
  choice — no Swift declaration of it can compile.** Three builds died proving it: (1) in an
  `extension` → `overriding declaration requires an 'override' keyword`, and `override` is legal in
  a class body and nowhere else; (2) in the class body returning `[any RCTBridgeModule]` →
  `cannot find type 'RCTBridgeModule' in scope`; (3) in the class body returning `[Any]` →
  `method does not override any method from its superclass`. 2 and 3 are a **catch-22**, and
  `RCTBridgeDelegate.h` says why: it only FORWARD-DECLARES `@protocol RCTBridgeModule;`. Swift
  imports a forward-declared ObjC protocol as an **opaque placeholder** — it participates in
  signature matching, so `[Any]` does not match, but it cannot be written down, so the matching
  signature cannot be spelled either. (`RCTBridgeModule.h` itself is no help: it imports
  `"RCTBundleManager.h"` with QUOTES, which makes it non-modular and keeps it out of the `React`
  module — which is why `RCTBridge` resolves in the same signature and `RCTBridgeModule` does not.)
  The Objective-C runtime has none of these problems: selector, type encoding `"@@:@"` and an
  `@convention(block)` of `id`s, and `respondsToSelector:` — which is the only thing React Native
  actually asks — answers yes for a method added that way. It is self-limiting too, since
  `class_addMethod` changes nothing and returns false if the class already implements it.
  So `TwilioEarlyInit.swift` is a template split on `// tcb:launch-call` (one line inside
  `didFinishLaunchingWithOptions`, anchored on the `ExpoReactNativeFactory(delegate:)` line so it
  lands BEFORE `startReactNative`) and `// tcb:file-scope` (the helper class), and the plugin also
  adds `import ObjectiveC`. It throws at prebuild if those anchors move — loud, not silent.
  **None of this Swift is compiled by `npm test`, `tsc` or prebuild**, so treat every edit to it as
  unverified until an EAS build goes green. The `class_addMethod` version went green on the fourth
  attempt — **build 5, 2026-09-10** — so that shape is known to compile; the three above are known
  not to. JS still
  calls `initializePushRegistry` at module scope, and on a patched binary that **replaces** the
  native registry rather than adding to it — `initializePushRegistry` assigns a fresh
  `TwilioVoicePushRegistry` to a strong property, so the first one deallocates — leaving a
  microsecond with no VoIP registration. Kept anyway, deliberately: the same OTA serves handsets
  still on the older binary, where that call is the only registry there is, and JS cannot tell the
  two apart. Skipping it wrongly would silently disable incoming calls altogether, which is far
  worse than a window nothing realistically lands in. And **this ships in a native build only,
  never by OTA**: an OTA cannot change `AppDelegate.swift`, so Settings now prints the native build
  beside the OTA number (`#66 · b5`) — that `b` half is what says whether the fix is on the handset,
  and it is the ONLY thing that does.
  Verified as far as it can be from here by running `npx expo prebuild --platform ios` and reading
  the generated file; nothing short of a device proves it works.
  Two more consequences. The module is handed over **once** — React Native's own contract is
  "always return a new instance for each call, rather than returning the same instance each time
  the bridge is reloaded", and a module carries per-JS-context state — so after the first React
  host we stand aside and a reload gets a fresh one. And every failure path returns nil, meaning
  "React Native, build it yourself", including the case where the SDK ever becomes a TurboModule:
  RN silently DISCARDS a handed-back instance that conforms to `RCTTurboModule`, which would leave
  ours alive as a second CallKit provider — the exact trap this design exists to avoid.
- **An invite that lands before JS subscribes is never re-emitted, and that window is now real.**
  The SDK's `sendEventWithName` is a no-op until JS calls `addListener`, so with the module alive
  from native launch a cold VoIP wake can ring, and be answered from the CallKit screen, while JS
  holds no `CallInvite` at all — an in-call screen driving nothing, which is the shape of the
  unresolved "no hang-up button" report. `registerForIncoming` therefore replays
  `voice.getCallInvites()` once its listener is attached, guarded on `pendingInvite` so an invite
  that did arrive by event is never announced twice.
- **`placeCall` de-duplicates by TIME, and that is deliberate.** Reported as "it rang my mobile
  twice"; `calls` held two outbound legs to one customer two seconds apart. Nothing retries — the
  app sent the request twice, because none of the five call sites guards the button and the only
  feedback ("Calling your mobile") is an Alert that appears AFTER the round trip, so the tap looks
  dead and you tap again. The guard lives in `placeCall` (the one choke point, above the
  VoIP/carrier branch) as a 5s per-number window rather than an in-flight flag, because `apiFetch`
  has **no timeout**: a request that never settles would pin a flag forever and dialling would stop
  working with no way back. Same reasoning removed a latch from `crashReport.ts`. **Module state
  plus a timeout-less fetch is a permanent wedge; prefer a window, which clears itself.**
- **Crash reporting never recorded anything until OTA 58, and the reason is a shape worth
  remembering.** The global handler did `void reportError(...)` — async, un-awaited — and then
  called the previous handler, which tears the process down. On a fatal error the SecureStore write
  raced teardown and lost, so `client_errors` was empty from the day the feature shipped
  (2026-09-08) to 2026-09-10. The fatal path uses `expo-secure-store`'s **synchronous**
  `setItem`/`getItem` now. Two review lessons attached: a failed prime/write must not be memoised
  as success (it would silently disable the thing forever), and **a regression test that reads
  source text is not a test** — the first version of both the crash-write test and the PushKit test
  passed with the fix fully reverted, one because the fake keychain mutated synchronously and one
  because `indexOf` matched the comment naming the function.
- **The mobile `admin` group is a SIBLING of `(tabs)`, which strands its hub screen.** Two things
  compound: the tab bar is not rendered under `/admin` at all (it lives inside `(tabs)`), and
  `admin/index` is the ROOT of the nested stack in `admin/_layout.tsx`, so React Navigation draws no
  automatic back button — there is nothing behind it *within that navigator*. The hub therefore had
  no way out but an edge swipe, which is undiscoverable and absent on Android. Fixed with an
  explicit `headerLeft`. The sub-screens were always fine: they are pushed inside that stack and get
  the usual chevron. **Anything new mounted as a sibling group needs its own way out.** The button's
  rule lives in `mobile/src/lib/nav.ts` (`leaveAdmin`) rather than inline, because a plain
  `router.back()` is a NO-OP on an empty history — a deep link or cold start straight to `/admin` —
  and a back button that visibly does nothing reads as the app having frozen, which is worse than
  the missing button it replaced.
- **The phone menu is on mobile as a LIST, not a canvas — and that reverses an earlier decision.**
  This file used to say the IVR editor stays web-only because "a drag-and-drop node graph is not a
  phone job". The graph isn't, but the DATA is: `Admin > Phone Menu` renders the same flow as a list
  of steps, each tappable, with every "go to" as a picker instead of a dragged line. The web editor
  still exists and is still better for a big rearrangement, because it is the only place that shows
  the shape.
  **The list is ordered by walking the flow from the entry node, never by row order.** `SELECT *`
  returns whatever it returns, and in the real production flow that puts the after-hours voicemail
  ABOVE the step that greets the caller — a list that shows you the end of a call before the start
  of it. `orderNodes` is a breadth-first walk following every next-field and every menu key, with
  anything unreachable listed separately rather than hidden: an orphan is nearly always a
  half-finished edit and is exactly what someone opening that screen is looking for.
- **`PUT /api/ivr/flows/:flow` is a DELETE-AND-REINSERT, so a client must send back what it does not
  understand.** `replaceFlowNodes` wipes the flow and re-inserts the payload, which means any field
  the mobile editor dropped would be destroyed. The trap is `positionX`/`positionY`: they are the
  WEB canvas coordinates, mobile never reads them, and losing them would flatten every node onto the
  origin the next time the web editor was opened — a mess nobody would connect to an edit made on a
  phone. They are carried on the mobile `IvrNode` type purely so they round-trip, and a test pins
  it. Same rule for anything added to a node in future.
  Deleting a step also has to UNLINK it (`removeNode`), or every reference to it becomes a dangling
  id that the flow engine only fails on when a real call reaches that point, mid-call, silently.
- **#91 shipped two features that could never work, and both were the same shape: a client sending
  a config the server refuses.** Found by `/code-review` after the merge (2026-09-11), which is the
  wrong order and is exactly what the review bullet below is about.
  (1) **"Add a step > Forward to a number" 400d every time.** `blankConfigFor("redirect")` is
  `{number: ""}` and `isRedirectConfig` was `isNonEmptyString`. Redirect was the ONE type whose
  blank config the endpoint refused — every "next node" field is deliberately allowed to be blank,
  and `replaceFlowNodes` persists unreachable nodes on purpose — so the fix is the SERVER, not the
  client: a step may exist before it is wired up. The web editor never hit it because it holds a
  new node LOCALLY and pre-checks before saving; the handset saves the instant a type is picked, so
  the editor can load it fresh.
  (2) **Deleting the entry step 400d every time**, while the confirm dialog carefully explained
  what would happen. `removeNode` returns `entryNodeId: null` and `handlePutFlow` requires a string
  matching exactly one node. Mobile now REFUSES it and says to pick the new starting step on the
  web — the web's own answer (re-point the entry at `nodes[0]`) silently moves where every call
  starts, which is worse than refusing.
  What makes the looser validator safe is **`incompleteReason`**, which marks a half-wired step on
  the list screen. A blank next-field and a blank redirect number both throw in the flow engine,
  and the DO catch-all then says "we're experiencing a technical issue" and hangs up on a live
  customer — so the old dialog's "callers reaching that point will fall through" was wrong too.
- **An "unfinished" badge covers only the types with NO server-side default, and getting that list
  wrong makes the badge noise.** `incompleteReason`'s first version reused the EDITOR's "which types
  show a prompt field" set, which is a different question — `wait` with a blank prompt plays the
  Australian ringback tone (#47, the intended configuration) and `callback` speaks
  "Thanks, we'll call you back soon." So a Hold step would have been badged permanently, inviting
  someone to "fix" it by typing text, which replaces the ring cadence with a spoken line on every
  hold poll. Voicemail is excluded too: a beep-only mailbox is terse but real, and the missing
  mailbox NAME is the gap that matters there. The set is `play`, `gather`, `input` — the three
  where a blank prompt really does leave the caller hearing nothing. A badge you have learned to
  ignore is worse than no badge, the same lesson as `divert_caller_id_last_error` clearing itself.
- **`/api/ivr/flows/:flow` answers a rejection with JSON now, because plain text reaches nobody.**
  Every 400 names the offending node and field, which is the entire point of validating on write —
  and `apiFetch` lifts a message only out of a JSON `{error}` body, falling back to "request failed
  (400)". So the handset reported nothing useful for a mistyped closed date, and a code comment on
  the mobile screen claimed the opposite. `jsonResponse({ error }, 400)` is what the rest of the API
  already does. The web editor reads the JSON and falls back to body text for the routes still
  answering in plain text (403 forbidden, 404 not found). **The same gap is still open on business
  hours** (`isDayWindow` → `invalid request body`) — see that bullet above.
- **A spread is not a round-trip guarantee, and a test asserting through one is not a test.**
  The `positionX`/`positionY` test added with #91 asserted through `removeNode`'s `{ ...n }` with a
  helper that set the positions regardless of the declared type — and TypeScript types are erased,
  so DELETING those fields from `IvrNode`, the mutation that would actually flatten the web canvas,
  left it green. Saves now go through **`toPutPayload`**, which names every field the server
  persists in a RUNTIME list (`IVR_NODE_PUT_FIELDS`), so dropping one breaks a test.
  `created_at`/`updated_at` are the only columns deliberately omitted — the server regenerates them.
  **Testing the helper is not testing the call site**: reverting `putIvrFlow` to
  `JSON.stringify(body)` left every test green, because nothing asserted on the bytes actually
  sent. That is pinned in `api.test.ts` now, against a stubbed fetch.
- **Every mobile screen that loads on FOCUS needs `keepEdits`, and the IVR step editor did not have
  it.** `useFocusEffect` re-runs on refocus, not just mount, and an incoming call pushes
  `/call-incoming` as a root-stack modal from anywhere in the app — so typing a new greeting, taking
  a call and coming back replaced the draft with the server's copy, with no dirty indicator to say
  it had gone. `on-call.tsx` already solved this; `business-hours.tsx` sidesteps it with a
  mount-only effect. The dirty test is `configsEqual`, one level deep with a JSON compare for a
  gather's `options`. **Any new screen on `useFocusEffect` joins this list.** Two companions from
  the same pass: `setError(null)` on a successful load, or one failed load pins the error screen for
  the life of the component (the error branch returns before the data branch, so every later load
  succeeds and repaints nothing); and the step editor **re-reads the flow immediately before
  writing**, because the endpoint is a whole-flow delete-and-reinsert with no version check and the
  screen's snapshot is as old as the time spent typing. That narrows the window from minutes to
  milliseconds — it does not close it. **The DELETE path needs that re-read more than the save
  does**, and the first version of the fix missed it: `removeNode` carries `entryNodeId` forward
  from whatever it is handed, so deleting from a stale snapshot reverts every web edit made since
  the screen opened, entry node included, while reporting success. It also re-checks `isEntry`
  against the fresh copy, since the entry could have MOVED to this step meanwhile. Both re-reads
  fall back to the snapshot on a failed GET rather than refusing — the point is not to clobber
  someone else's edit, and turning a transient failure into "you cannot save" blocks a write the
  PUT would have accepted.
- **A number field that cannot be cleared will ship a zero into a live call.**
  `Number(text.replace(/\D/g, "")) || 0` straight into the draft meant backspacing the box snapped
  it to "0", and it could never be empty. `numDigits` is passed to `<Gather>` verbatim and
  `isInputConfig` only checks `typeof === "number"`, so clearing the field intending to retype it
  and then tapping Save built a live Gather asking for **zero digits**. `NumberField` owns its own
  text, commits nothing while the box is empty, and clamps to a per-field `min` — per-field because
  zero retries is a legitimate answer and zero digits is not. It carries the same `pushed` ref as
  the schedule editor's `TimeField`, for the same reason: without it the commit echoes back and
  rewrites the box mid-word.
  **That `min` must be 0 or 1, and the bound is load-bearing.** Review caught the first version
  using 5 for `timeoutSeconds`: typing "3" committed 5 while the box still read 3, and
  `keyboardShouldPersistTaps="handled"` means a tap on Save never blurs the field and never
  reconciles them — so it would have saved a ring time the admin never chose. With a floor of 1
  every digit string except a lone `"0"` is already above it, so the clamp can never fire
  mid-typing and the divergence is unreachable.
- **The Admin hub's back button is pinned by a test now, and the screen list is data so it can be.**
  `leaveAdmin`'s pop-or-replace rule was tested from the day it shipped, but nothing tested the
  `headerLeft` that CALLS it — delete that one line and every test stayed green while the hub was
  stranded exactly as reported. `admin/_layout.tsx` exports `ADMIN_SCREENS` and the test asserts the
  hub has a `headerLeft` and the pushed sub-screens do not. Render tests are not an option here:
  `auth.test.tsx` sits in `testPathIgnorePatterns`, so `@testing-library/react-native` is installed
  but effectively unused.
- **`Row`'s leading icon had no Android fallback, and still doesn't at most call sites.** `Row`
  renders `<Icon name={icon}>` with no `fallback`, so on Android every icon tile across Settings and
  Admin is a coloured square containing a blank `ellipse-outline`; only the trailing chevron was
  ever given one. `Row` now accepts `iconFallback` and new rows pass it, but the EXISTING call sites
  were deliberately left alone rather than widen an unrelated change — so that is a known,
  outstanding Android cosmetic bug, not an oversight. iOS looks perfect, which is why it survived
  this long.
- **`Icon` renders a blank `ellipse-outline` on Android for any name given without a `fallback`.**
  It is SF Symbols on iOS and Ionicons everywhere else, and the fallback is not optional in
  practice: four controls added to the on-call screen (the reorder arrows and add/remove) shipped
  without one and would have been meaningless circles on Android, on the exact screen where the
  arrows ARE the affordance. iOS looks perfect throughout, so nothing catches this locally.
- **The mobile schedule editor commits a finished time ON CHANGE, and both halves of that are
  load-bearing.** Reported as "it won't let me change business hours from 10pm", which was two
  separate faults with the same symptom.
  `TimeField` committed on BLUR only, and the enclosing ScrollView sets
  `keyboardShouldPersistTaps="handled"` — so a tap on Save goes straight to the button without
  blurring the field. The draft never changed, `dirty` stayed false, and Save sat disabled reading
  "Saved". Nothing happened and nothing said why. And `normalizeTime` rejected `10pm`, which makes
  the field REVERT silently, so typing the time as anyone would say it looked like a refusal.
  Committing on change then has its own trap, caught by review before it shipped and worth more
  than the original bug: the commit echoes back through the controlled field's re-seed effect. At
  `17:3` the value is complete enough to parse as 17:03, the parent hands 17:03 back, the box is
  rewritten mid-word, the final `0` makes `17:030`, and blur reverts to **17:03**. Hours would have
  saved as closing at three minutes past five. `TimeField` keeps a `pushed` ref of what it last sent
  up and ignores a `value` that is its own echo.
  **"Finished" is prefix-freedom, not a shape.** A shape rule (separator, or 3-4 digits) calls
  `17:3` and `103` finished and commits 17:03 and 01:03. The rule is: no digit can be appended to
  make another valid time — so `930` and `17` are finished, `103`, `123` and `17:3` are not.
- **Nothing on the mobile client checks `close > open`, and the API's rejection is opaque.**
  `isDayWindow` refuses the whole SEVEN-DAY schedule if one window is inverted, the worker answers
  the plain text `invalid request body`, and `apiFetch` cannot parse that as JSON — so the handset
  shows "request failed (400)" with no clue which day is wrong. Known and not yet fixed; the useful
  version names the offending day. An OVERNIGHT window (say 22:00-06:00) is inexpressible for the
  same reason, and that is a real limitation rather than a bug: only `00:00` as a close means
  midnight.
- **RUN `/code-review` BEFORE SHIPPING, not after — and expect the FIX to need reviewing too.**
  Standing instruction from Phill, and 2026-09-10 is the case for it. The on-call rotation (#89) was
  merged and deployed unreviewed; `/code-review` then found **14** defects in it, **15** in the PR
  that fixed those (#92), and **15** in the PR that fixed those (#94). The count did not fall
  between rounds, and the new defects were consistently in the newest code — the second round
  reopened the exact incident the first had closed, and the third found three faults in a check the
  second had just written.
  The three that would have caused an incident, all of the same shape (**a thing that fails without
  saying so**): a rotation could be silently re-anchored from a handset, moving who was on call
  TONIGHT; the demo account could be put on call, where it rings nobody while Health Checks reports
  it as fine; and Health Checks went green over a rota wired to nothing.
  **Mutation-test every regression test.** Four separate tests this day passed against fully
  reverted code (a fifth and sixth turned up the next day — the transcripts webhook test, and #91's
  canvas-positions test) — the corrupt-rotation test (the branch was unreachable), the timezone test
  (`process.env.TZ` does nothing), and both write-normalisation tests (they asserted THROUGH reads
  that normalise too). "A test that reads through the fix is not a test" now sits beside "a test
  that reads source text is not a test"; the fix for both is to assert the raw stored value and to
  revert the change and watch the test fail.
- **A defaulted exclusion list FAILS OPEN, so security-shaped parameters are required ones.**
  `excludeEmails: string[] = []` meant a new caller — or a route refactor dropping `demoEmails(env)`
  — compiled cleanly and silently restored the demo account to the pickers. Both the on-call
  handlers and `/api/staff` take it required now, so omitting it is a type error. `/api/staff`
  matters more: it is the UNGATED roster the softphone's transfer picker reads, where an App Review
  reviewer appearing as a destination could be handed a real customer's live call.
  The filter itself is **one function**, `excludeDemos` in `src/demo`. It existed as three
  byte-identical copies, and the single surface that skipped it (`checkOnCall`) is exactly where
  the bug turned up.
- **"Is the rota wired up?" is a REACHABILITY question, and three cheaper answers are all wrong.**
  `checkOnCall` asks whether an after-hours call can reach a ring step targeting `on_call`.
  (1) Counting rows counts a step nothing points at — blank next-fields are legal and
  `replaceFlowNodes` persists unreachable nodes, so a dragged-in ring step satisfied the count over
  a rota ringing nobody. (2) Walking every branch follows the OPEN side of `business_hours`, so a
  step on the daytime path reported the AFTER-HOURS rota as fine — the one thing the check exists to
  deny; `flowEngine` takes `closedNextNodeId` and only that when `isAfterHours`, so the walk does
  the same. (3) Loading one flow drops a next-id crossing into another, and node ids are a global
  PRIMARY KEY (`nodeExistsInOtherFlow` exists because of that, `loadNodeById` has no flow
  predicate) — so a correctly wired rota read as broken, which would have someone dismantle a
  working setup. A flow with **no entry node** returns `null`, "could not verify": that state means
  every inbound call already fails in `loadEntryNode`, i.e. the phone system is down, and telling
  someone to add a menu step then is the wrong emergency.
- **Preserving the rotation anchor does not preserve who is on call tonight.** `rotationMemberFor`
  indexes on `weeksBetween(anchor, week) % members.length`, so the member COUNT is as load-bearing
  as the anchor: adding a fourth tech to a three-person rota re-indexes the current week and moves
  tonight's on-call person, mid-week, silently. The mobile screen computes before/after with a
  client copy of the rule and asks first — skipping the question when the current week is an
  override, because there the override wins and nothing changes. The eight-week preview only
  reloads AFTER a save, so that dialog is the one moment it can be said before it is true.
- **`git checkout -B <branch> origin/master` DISCARDS anything on that branch that is not merged.**
  Used repeatedly this repo to restart the designated branch after each squash merge, which is
  correct — but a CLAUDE.md commit that had been pushed and not yet merged was silently thrown away
  by the next reset, and the whole memory pass had to be redone an hour later with nothing saying it
  had gone. **Merge, or check `git log origin/master --grep=` for it, before resetting.** A pushed
  branch is not a saved branch here, because the branch itself is the thing being reset.
- **`npm test` cannot run without a Cloudflare login, and the reason is the `ai` binding.**
  Workers AI is remote-only, so vitest-pool-workers tries to open a remote proxy session at CONFIG
  PARSE time and dies with "You must be logged in to use wrangler dev in remote mode" before a
  single test file loads — which looks like a broken checkout rather than a missing credential. In a
  sandbox with no `CLOUDFLARE_API_TOKEN`, copy `wrangler.jsonc` without the `"ai"` key and point a
  throwaway vitest config at it (`--config`); every suite including `transcribe` passes, because
  they mock the binding anyway. Delete both files afterwards — they must never be committed.
- **`process.env.TZ` set inside a test does NOTHING, and that made a timezone test theatre.** Node
  caches the zone, so a test that loops over timezones asserting a date renders identically passes
  just as happily against code reading LOCAL date parts, whenever the suite itself runs in UTC —
  which is the default here and in CI. The first version of `mobile/__tests__/onCall.test.ts`
  passed with the fix fully reverted, the third instance of the lesson already recorded for the
  crash-write and PushKit tests. The invariant is "never reads local parts", so that is what is
  pinned now: spy on `Date.prototype.getDate`/`getMonth`/`getFullYear`/`getDay` and assert they were
  never called. That version fails under any ambient timezone.
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

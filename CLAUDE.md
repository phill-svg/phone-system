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
  And the pin's original rationale (Expo Go on the App Store only serves SDK 54, and Phill tests on
  a real iPhone without a paid Apple account) is **dead**: there is a paid account, a signed
  TestFlight build, and internal testers, so Expo Go is not how this app is run. `mobile/AGENTS.md`
  stated that dead reason as current until 2026-09-21 and now carries the live one instead — the
  cost of moving, chiefly that the CallKit fix lives in generated native code no local command
  compiles. The pin stands on that; treat the upgrade as real work with real risk, not a version
  bump.
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
- **ServiceM8 runs 15 minutes AFTER a call ends, on a cron — not from the status webhook.** Staff
  routinely create the ServiceM8 client or job during the call or right after hanging up, so firing
  the instant it ended searched for a record that did not exist yet, found nothing, and never tried
  again — the note and the contact were both lost for that call. The status webhook now only leaves
  `calls.servicem8_synced_at` NULL (migration `0031`) and `src/servicem8/syncQueue.ts` sweeps on the
  cron. A **second cron, `* * * * *`, exists solely for this sweep** — the `*/5` tick would have
  stretched the original "3 minutes" to 3–8; `scheduled()` branches on `event.cron` so everything
  else stays on `*/5`. Each call is CLAIMED in D1 before any work, because two overlapping ticks
  would otherwise post the diary note twice. The sweep reaches back only 2 hours, which is what
  stops the first tick after a deploy noting every call in history, and also bounds retries.
  **Raised from 3 to 15 on 2026-09-11** (`SERVICEM8_SYNC_DELAY_MS`), after a call that ended at
  13:03:18 was looked at at 13:06:50 and the job was created at 13:09:33 — after the only look it
  would ever get. Two things follow. The wait still gets exactly ONE look: a `no-match` claims the
  row permanently (only `failed` releases it), so a job written up at minute sixteen is lost exactly
  as before — 15 minutes moves the line, it does not remove it, and the durable fix is to retry a
  `no-match` inside the existing 2-hour window. And the caller's NAME now takes 15 minutes to appear,
  so a new customer sits in Recents and in the thread as a bare number until then. The number is
  quoted in Admin > Health Checks, which DERIVES it from the constant — do not retype it there.
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
  falling over must be able to say so whoever holds it). Handsets are on **OTA 67**, and the first
  binary carrying the native CallKit fix is **build 5** (2026-09-10), **confirmed installed on
  Phill's iPhone on 2026-09-11**. Settings shows both as `#67 · b5` — and only from OTA 67, which
  is the first build where that `· b5` half actually renders (see the bullet on it below).
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
  Superseded on 2026-09-11: **OTA 67** on both channels, worker deployed, migration `0036` applied.
  **Still outstanding at the end of it, and almost none of it is code:**
  * ~~Build 5 has never been proven on a device.~~ **2026-09-11: build 5 IS installed, and a real
    call still did not ring the softphone** — so the CallKit watchdog is ruled out as the remaining
    cause and the lead is the VoIP push credential (see that bullet below). A locked-phone test call
    is still the proof, but only once `TWILIO_PUSH_CREDENTIAL_SID_IOS` is confirmed set and not
    sandbox; until then there is nothing for the handset to be woken BY.
  * **The IVR's after-hours branch was wired to the on-call rotation on 2026-09-16, then UNWIRED
    the same night** after it AMD-misfired a live caller into voicemail mid-conversation — see the
    on-call-wiring bullet lower in this file. `main`'s closed branch is back to plain voicemail.
    The rotation itself still holds Phill (anchor `2026-09-07`) but nothing in the IVR reaches it.
  * `staff_users` still holds only Phill plus the demo reviewer account, so there is nobody ELSE to
    rotate between — the rota rings the one person there is until a second tech is added.
  * ~~Speaker-labelled transcripts need the Console's **Dual-channel Recording for Conference**
    switch.~~ **Resolved 2026-09-12 by not depending on it**: that switch was Enabled and saved and
    Twilio was still returning mono, so the recording moved to `record-from-answer-dual` on the
    `<Dial>`. See the bullet on it below. Still worth reading one real transcript to confirm the
    labels are the right way round.
  * **A Twilio Auth Token was exposed in chat on 2026-09-10 and needs rotating** if it has not been.
    The ORDER matters: create a SECONDARY token in Twilio, update `TWILIO_AUTH_TOKEN` in the
    Cloudflare dashboard (Workers & Pages > tcb-voip > Settings > Variables and Secrets), make one
    test call in and out, and only then promote it. Killing the old token before the worker holds
    the new one stops every inbound call, because that value both validates Twilio's webhook
    signatures and authenticates our REST calls.
  * The **web** `/admin/settings` on-call section and the mobile screen are separate
    implementations of the same rota; a change to one usually needs the other.
- **Recent work (2026-09-13): a whole-repo bug scan, and all 49 findings fixed.** The `bug-hunter`
  skill scanned `origin/master` in 9 domain groups (one agent finds, a separate agent challenges and
  rules), giving 49 confirmed bugs. #105 shipped 5 (worker only); **#106** shipped the other 44 (worker +
  **OTA 70**, both channels). The findings, fix list and raw verdicts are NOT in the repo, on purpose:
  `C:\Users\Phill\Documents\TCB Phone bug audit 2026-09-13\`. Every fix has a test that failed first,
  and each batch was run through `/code-review` until clean. **That took up to four rounds per batch
  and caught about 20 real defects in the fixes themselves**, one of which (a first attempt at the
  sibling-voicemail race) made things worse and was reverted, not patched. The rule stands: review
  the fix, then review the fix to the fix. Still needing a handset: a locked-phone launch, answering
  from the lock screen then opening the app, an attended transfer, call waiting, mute while dialling.
- **Hold, transfer and complete-transfer resolve the conference from the staff member's OWN leg**
  (`ownLegConference`, `softphone_call_legs.conference_name`). A client-supplied `conferenceName` is
  ignored: an inbound call's conference is named after the CALLER's leg, which no client knows, so
  web Hold 404'd on every inbound call and mobile Hold only ever flipped local state. Complete-transfer
  removes **only the requester's own leg** (it used to remove any `callSid` it was given, i.e. a staff
  member could hang up the customer) and refuses with 409 until the colleague has joined, or the
  lone-conference cleanup ends the call on the customer. Mobile transfer is **attended only**; Blind
  was removed deliberately, because an unanswered blind transfer strands the customer alone.
- **Only the first answer of a ring round bridges, and each round is dialled with other events held.**
  `dialRound` wraps the dial-and-store of `startRing`, `performDeferredDial` and the cascade advance
  in `ctx.blockConcurrencyWhile`: creating legs is several Twilio/D1 round trips, and without the hold
  an answer to the first leg arrived before `activeRing` existed and was turned away with nobody
  bridged (caller on endless ringback). The cost: a throw or 30s inside resets the object, so keep
  anything that can throw OUT of `dialRound`. An answer after the bridge is turned away with a short
  `<Say>` and recorded in `turnedAwayAgentSids`, whose `completed` status must NOT run
  `cleanupLoneConference` (it hangs up in the window between the caller and the bridged staff leg
  joining). `bridgedAgentSid` is per round, cleared at round start, and an async-AMD machine verdict
  rescues the caller only when it is for that leg. **Known limit, accepted:** if a staff member's
  carrier voicemail answers a split second before a real person, the voicemail leg bridges, the human
  is turned away and the caller is rescued to business voicemail. Not dropped, but not connected.
- **`handleAgentStatus` cleanup has three cases, and all three bit.** `completed` (not turned away)
  runs the lone-conference cleanup. A pre-answer failure (`canceled`/`no-answer`/`busy`/`failed`) of
  an INBOUND sibling does nothing: answering cancels the siblings, and their callbacks land between
  the caller joining and the staff leg joining. A failure of the OUTBOUND softphone customer leg
  (`outbound_target_sid`) hangs up the staff member's own leg instead, because `/twiml/voice-app`
  dials the customer before the staff leg has joined, so there may be no conference to end yet. And
  `handleQueueLeft` with `queueResult === "hangup"` returns `<Hangup/>` without walking the no-answer
  branch, which in production is a second ring round (it re-rang the whole team for nobody).
- **Transcripts: a refused request is marked `request_failed` and reported.** It fails Health Checks
  when nothing was transcribed and warns alongside working transcripts (the marker is permanent and a
  single 5xx sets it). Live D1 on 2026-09-13: 76 recorded calls, **zero** ever given a transcript sid.
  **Three separate causes, each hiding the next, and `intelligence_error` is what made them
  legible.** Read that column on the newest recorded call before diagnosing anything here — it holds
  Twilio's own words, and the answer has changed twice.
  (1) The AU1 `TWILIO_AUTH_TOKEN` was being sent to the US1 host `intelligence.twilio.com` (tokens
  are per-region). Real, fixed in **#115** (`globalAuthHeader`).
  (2) `TWILIO_INTELLIGENCE_SERVICE_SID` was stored **with a stray quote** —
  `400: {"code":1302,"message":"GAfa08e9518a03474beb8a4c6b9c07b412\" is invalid"}` on 2026-09-17.
  Re-saved unquoted with `npx wrangler secret put` (effective immediately, no deploy). A Cloudflare
  secret can never be read back, so this was only ever confirmable by the error going away — which
  it did: the next call carried a different 400.
  (3) The request itself was malformed, and had been since the feature shipped. The 21:34 call on
  2026-09-17 reads
  `400: The media_participant_id can only be set for transcript with media url`. We create from a
  recording sid, and Twilio documents the `participants` override only with `media_url`. It is a
  WHOLE-REQUEST rejection, so the call got no transcript at all. The array is gone entirely — it only
  labelled channels in Twilio's own viewer, and nothing reads those roles back (see the staff-channel
  bullet below). Dropping `role` with it means no second media-url-only field can take its place.
  Do not widen the search: voicemail transcripts work (under ~5s legitimately comes back empty) and
  plain unlabelled call transcripts work on nearly every answered call, both directions; it is only
  the SPEAKER-LABELLED ones that have never once succeeded. The 14 rows already at `request_failed`
  are terminal — the sweep selects on `intelligence_sid IS NOT NULL` — so nothing retries them and
  those calls have no labelled transcript, permanently.
- **The App Review demo account is denied by default on `/admin/`**, except `/admin/phone` and
  `/admin/messages`, which render from the substituted `/api/`; everything else read real D1 and a web
  login lands on `/admin/live`. Its `POST /api/push/register` is swallowed too, since every push goes
  to every stored token with real customer names and message text.
- **The login lockout is `reserveAttempt`: one conditional INSERT before the password hash.** Count,
  hash, then record let a parallel burst all pass the count (20 of 20 in the test). A success clears.
  **`SELF.fetch` serialises requests in the test worker, so a concurrency test must call the handler
  directly**; the SELF version of this test passed against the broken code.
- **Message threads are keyed by `threadPeer`**, which normalises only phone-shaped strings
  (`0412 345 678` -> `+61412345678`) and leaves Messenger ids and alphanumeric senders ("Service NSW")
  untouched. Sending normalised but lookup did not, so a new message showed an empty thread.
- **Mobile, the durable pieces.** There is ONE native CallInvite handler with a subscriber stack in
  `voice.ts` (the newest registration is told; two registrations used to open two ringing screens);
  `unregisterFromIncoming` bumps a generation that stops a pending registration retry re-registering
  a signed-out phone. The session token is `tcb_session_token_v2` with `AFTER_FIRST_UNLOCK`: the old
  default could not be read on a locked-phone VoIP launch, the restore threw and the app sat on its
  spinner with no call UI (a candidate cause of the "no hang-up button" report). `getTokenWhenReadable`
  waits for unlock, then backs off ~3s before treating refusal as signed out; launch reads share one
  in-flight read so the key migration cannot race. `createScreenExit` makes a screen leave exactly
  once and only while on top (call-active). The thread query is **disabled while the thread is not
  focused**: every load marks the thread read for the WHOLE team, and polling or the app-foreground
  refetch under a call screen cleared everyone's unread dot.
- **Test-runner gotchas met on 2026-09-13.** The full worker suite is flaky under load on this machine
  (timeouts in files unrelated to the change, and once `workerd` crashed at startup with
  `std::terminate`); re-run the failed files alone before investigating. And `mobile/__tests__/auth.test.tsx`
  shows as a failing suite on Windows because its `testPathIgnorePatterns` entry uses `/`; it is
  ignored correctly on Linux, including in `publish-ota.yml`.
- **READ `docs/superpowers/` BEFORE IMPLEMENTING. It is not decorative, and skipping it cost a day.**
  This file says so at the top and it was ignored on 2026-09-11 through an entire softphone
  investigation. `specs/2026-08-19-ios-softphone-phase1-design.md` lists, under Risks: *"APNs
  environment mismatch (sandbox vs production push credential) is a common cause of 'no incoming
  ring'"* and *"VoIP background mode + push entitlement must be exactly right or background ringing
  silently fails"*. Both were written a month before the morning they explained, and both were
  unread while the same symptom was chased through CallKit, build numbers and OTA versions instead.
  The 24 documents in there are the cheapest reading in this repo.
- **A missing VoIP push credential is why a softphone never rings, and NOTHING said so.**
  `mintAccessToken` sets `push_credential_sid` only `if (opts.pushCredentialSid)` — so an unset
  secret mints a perfectly valid access token with no push credential on it. The app registers
  happily, presence goes green, and Twilio has no way to wake it: an inbound call rings
  `client:{email}` for the FULL timeout and the handset never stirs. No error, no log line, no
  crash, and `/admin/errors` stays empty because no JavaScript ever runs. That is exactly the
  10:28 call on 2026-09-11 — 22s then 62s of ringing into a phone that was never told.
  `TWILIO_PUSH_CREDENTIAL_SID_ANDROID` is a plain var in `wrangler.jsonc`; **the iOS one is not
  there at all**, so it has always depended on a wrangler secret (`deploy.yml` does not set
  secrets) that nothing verified. `Admin > Health Checks > Ringing the app` now answers it, and it
  asks Twilio rather than trusting the var: a 404 means the SID is not in au1 (see the next
  bullet), and `sandbox: "true"` on an APNs credential means silence on any TestFlight or App Store
  build, because those talk to PRODUCTION APNs. Could-not-reach is a warn, never a fail — a Twilio
  blip must not send someone rebuilding credentials that were fine.
- **A PUSH CREDENTIAL MUST LIVE IN au1, AND THE CONSOLE CANNOT MAKE ONE. This cost two days.**
  Twilio's Voice SDK regional guide states the binding rule: *"The Twilio resources referred to by
  the Access Token (the API Key, TwiML Application, **and Push Credential**) must exist in the
  Twilio Region specified in the Access Token."* `mintAccessToken` sets `twr: "au1"`, so a us1
  credential on the token is not a near-miss — Twilio has nothing to send a VoIP push with and the
  handset is never woken. That is **error 52161**, and it is what commit `8822611` hit on Android
  on 2026-08-23.
  What makes this a trap is that Twilio ALSO says *"Mobile push credential creation for the AU1
  region is not supported"* and *"REST API operations that manage Push Credentials … are supported
  only in US1"*. **Both are true of the CONSOLE and false of the REST API.** The au1 host creates
  and reads them perfectly well:
  ```bash
  curl -X POST https://notify.sydney.au1.twilio.com/v1/Credentials -u "$ACCOUNT_SID:$AU1_AUTH_TOKEN" \
    --data-urlencode Type=apn --data-urlencode FriendlyName="..." \
    --data-urlencode Certificate@voip_cert.pem --data-urlencode PrivateKey@voip_key_rsa.pem \
    --data-urlencode Sandbox=false
  ```
  (the AU1 **auth token**, which is a different value from the us1 one — API keys and auth tokens
  are per-region. `Invoke-WebRequest` fails this POST with "Cannot follow an insecure redirection";
  use curl.)
  So **the US1 Console list is NOT the account's list**, and a 404 from `notify.twilio.com` says
  nothing whatsoever about an au1-homed account. Checked live 2026-09-12: the au1 host returns 200
  for `CRa514b67c…` (Android FCM) and `CRa85b8607…` (iOS APNs) and **404 for `CR7b85225…`**, a real
  credential that simply sits in us1.
  The iOS credential is `CRa85b8607a3c0fa5a465024590c9ff96a` (apn, sandbox false), created
  2026-09-12 from an Apple **VoIP Services Certificate** — not a standard APNs cert, which Twilio's
  own FAQ says fails exactly this way, and not a `.p8` key, which their APNs credential does not
  take. Use a **fresh CSR**: reusing one that already made a regular APNs certificate causes
  "service type confusion" and the certificate then looks fine and silently does not work.
  **The iPhone rang, locked, at 07:28 on 2026-09-12** — the first time it ever has.
  Two things that wasted most of that investigation, recorded so nobody repeats them. A **foreground**
  app is rung over the Voice SDK's own signalling connection with **no push involved**, so "it rang
  while I had the app open" is never evidence about the push credential — only a locked or killed
  handset tests it. And the Expo dashboard's push graph is the **other** push system entirely (SMS,
  voicemail, missed-call alerts); 100% delivery there says nothing about VoIP push. Getting the
  missed-call notification but no ring is the signature of exactly this bug.
- **The `· b5` in Settings never rendered, on any device, ever.** It read
  `Constants.nativeBuildVersion`, which is not a property of `Constants` in SDK 54 — only a
  `@deprecated` comment pointing at `expo-application`. `Constants` is typed `& Record<string, any>`,
  so it compiled clean and was `undefined` everywhere, from the day it shipped in OTA 60. This file
  called that half "the ONLY thing that says whether the fix is on the handset"; it printed nothing.
  It comes from `expo-application` now, through one `NATIVE_BUILD` constant that both the Settings
  screen and push registration read. **And `expo-application` must stay in `mobile/package.json`**:
  the first version imported it while it resolved only as a transitive dep of `expo-notifications`,
  and its native module loads with `requireNativeModule`, which THROWS — `api.ts` is imported by
  nearly every screen, so the day that hoist changed every handset would white-screen on launch
  with no JS left to report it.
- **The handset reports its build to the server now** (migration `0036`, on push registration —
  the one call every signed-in handset makes on launch), so "is the native fix on that phone?" is a
  Health Check rather than a question someone answers by reading their own screen aloud. An iPhone
  below `b5` FAILS and names the fix; one that has not reported WARNS rather than passing, because
  unknown is not the same as fine. Bounded to 30 days so a spare phone in a drawer cannot pin it
  red forever, and the build is parsed strictly — `Number("1.0.4")` is NaN and `NaN < 5` is false,
  which would have cleared a handset the check never actually read.
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
  `&conference=1` on the callback URLs we build ourselves. Since 2026-09-18 every recorded flow is a
  dual `<Dial>` recording flagged `rec=dual` instead (caller leg, softphone customer leg,
  call-via-mobile), where mono coming back is a real FAULT rather than the Console switch — so the
  `conference=1` path is now effectively unused, kept for the fallback it describes. Inferring it
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
  The channel rule that default rests on: a DialVerb dual recording puts channel 1 on the **parent
  call**, and for an inbound call that parent is the **CALLER** — so the customer is channel 1 and
  **staff are channel 2**, which is why the default is 2. (For a CONFERENCE recording it was channel
  1 = whoever joined first, which happened to give the same answer for a weaker reason.) This
  paragraph said "staff are channel 1" for about half an hour on 2026-09-12, left over from a
  reverted attempt at putting the recording on the staff leg; that is the sentence a future session
  reads before touching `transcript_staff_channel`, and believing it labels every inbound transcript
  backwards.
- **An inbound call is recorded by the CALLER's leg, and that one sentence is the whole design.**
  Speaker labelling needs two channels, and a `<Conference>` recording's channel count is governed
  by one account-wide Console switch — **Dual-channel Recording for Conference**, Voice > Recordings
  > Settings. On 2026-09-12 that switch was confirmed **Enabled and saved** and Twilio's own
  Recordings API still reported `channels: 1, source: Conference` for every recording on the
  account, including a 143-second call answered that morning. **The switch does not work here; do
  not send anyone to it.** "The transcripts aren't working" was that, twice, on two separate days.
  So the recording must be a `<Dial>` recording — `record="record-from-answer-dual"`, which Twilio's
  `<Dial>` page documents for exactly this shape (*"a dual-channel recording for a `<Dial>` with a
  nested `<Conference>`"*) and which produces a `source: DialVerb` recording no account setting
  touches.
  **Which leg's `<Dial>` is the entire question, and the first answer was wrong.** It went on the
  STAFF leg (`renderDialAgentIntoConference`) and `/code-review` found two faults the same hour:
  (1) a `<Dial>` recording belongs to EVERY leg rendering that document, and two do per call — the
  original staff leg plus the transfer target on a warm transfer, or the agent leg plus the dialled
  customer on an outbound softphone call. Both post to the same callback, `recording_url` is
  last-write-wins, so half the conversation was orphaned in Twilio, with a doubled Intelligence bill
  and a second `pending` write able to reset a completed transcript. (2) "channel 1 is the staff
  member" held only where the parent call IS staff, and `/twiml/voice-app` renders that same document
  on the CUSTOMER's leg — so every outbound transcript would have been labelled backwards.
  It lives on **`renderJoinConference`** now — the caller's own leg. There is exactly ONE caller and
  their leg lasts the WHOLE call (staff legs come and go across a transfer; the customer never
  leaves the conference), so it is one continuous recording per call that no other leg can overwrite,
  and no future flow can add a second. `handleAgentAnswer` therefore passes **`record: false`** on
  the staff leg — load-bearing, not tidy-up — and a test at the CALL SITE pins both halves, because
  testing the two render helpers in isolation does not test which document each leg is handed, which
  was the defect.
  **Outbound follows the same rule since 2026-09-18: record on the CUSTOMER's `<Dial>`, dual.**
  Before that both outbound flows were mono by construction and never labelled. The softphone's
  dialled customer leg (`transfer-answer?rec=conf`) is a leg of its own with its own `<Dial>`, so it
  records there (`renderDialAgentIntoConference({ dual: true })`) and the agent leg in
  `/twiml/voice-app` passes `record: false` — the inbound arrangement exactly, one recording per
  call. Call-via-mobile (`renderBridgeToCustomer`) is the exception that cannot follow it: the
  customer is a `<Number>` dialled FROM the staff mobile leg, so that leg executes the `<Dial>` and
  channel 1 is STAFF. It records dual anyway and says so with `staffch=1` (next bullet). Note the
  softphone mapping is inferred from the same documented rule as inbound and has not yet been read
  off a real outbound transcript.
- **Which audio channel is the staff member is decided PER CALL, with a setting as the fallback.**
  Since 2026-09-18 (migration `0040`) the leg that chooses a recording declares it as `staffch=` on
  the recording-status callback URL, the webhook stores it in `calls.transcript_staff_channel`, and
  the sweep reads that first: **2** wherever the recording sits on the customer's own `<Dial>`
  (inbound caller leg, outbound softphone customer leg), **1** on call-via-mobile, where the staff
  mobile executes the `<Dial>`. One account-wide value cannot be right for both, and being wrong is
  silent. Only 1 or 2 is stored; NULL — every row recorded before this — falls back to the setting
  below (`transcript_staff_channel`, default **2**). For an inbound call that 2 is now structural rather
  than a guess: the recording is on the CALLER's `<Dial>`, a `<Dial>` recording puts channel 1 on
  the **parent call**, and the parent there is the customer — so channel 2 is whoever they are
  speaking to, across a transfer included, because the caller's leg never changes.
  It defaulted to 2 before this too, but for a weaker reason — a `<Conference>` recording gives
  channel 1 to whoever joined first, and the caller is redirected in before the staff leg answers,
  so the caller "usually" landed first. That was a race being read as a rule. It briefly became
  **1** on 2026-09-12 while the recording sat on the staff leg; when that placement was reverted so
  was this.
  **Flipping the setting no longer fixes a reversed transcript.** Every recorded flow declares
  `staffch` now, and the per-call value always wins, so the setting only labels rows recorded
  before migration `0040`. If a real transcript comes out with `Customer:`/`Staff:` swapped, the
  fix is the `staffch=` value at THAT flow's call site (`worker.ts`: `renderJoinConference`,
  `transfer-answer`, `mobile-bridge`; `CallSession.ts` for the inbound race-fallback) plus
  `UPDATE calls SET transcript_staff_channel = …` for the calls already recorded wrong. Kept
  deliberately rather than letting the setting override: which channel is staff differs by flow,
  and one global override would re-break whichever flow was already right.
  The SETTING is read in **exactly one place**: the sweep, at collection time
  (`intelligenceQueue.ts`), and only when the call carries no per-call value. The recording-status
  webhook used to read it too, to label the channels in the transcript CREATE — that went with the
  `participants` array, since Twilio refused the request that carried it. So Twilio's own
  participant roles are never set and never read; the labels in `call_transcript` come from the
  per-call value or this setting, nothing else. `getTranscriptStaffChannel` still **catches `JSON.parse`**, because a hand-edited
  junk row would otherwise throw inside the cron tick. The first test for that seeded `'7'` — valid
  JSON, so the guard was never executed and deleting it left the test green.
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
- **The rota was wired to the IVR on 2026-09-16, and UNWIRED again a few hours later.** Wired
  version: `main`'s entry (`business_hours` node `n_7lk2oio`) had its `closedNextNodeId` pointed at
  a new gather ("If this is urgent, press 1 to speak with our on call technician...") whose digit-1
  option rang a new node targeting `on_call`. First real after-hours call through it (00:50,
  2026-09-17) exposed why this needs to wait: `MachineDetection=Enable` on the on-call mobile leg
  runs Twilio's default heuristic with no tuned thresholds, and it misfired ~4.6s after Phill
  genuinely answered — `answered` then `mobile_machine_answered` then the AMD rescue (correctly, by
  its own logic) redirected a LIVE caller to business voicemail mid-conversation. The orphaned
  recording's transcript: "Could be, though." — a conversation fragment, not a greeting.
  Reverted the same way it was wired: directly via D1, not a deploy. `closedNextNodeId` back to
  `n_pkqmsmd` (the shared voicemail node); the gather and on-call ring node it pointed at
  (`n_1m36drd`, `n_nc3xde0`) DELETED rather than left dangling, since nothing referenced them once
  unwired. `settings.on_call_rotation` (one member, `phill@tcbpestcontrolcanberra.com.au`, anchor
  `2026-09-07`) and the on-call admin screens are untouched — only the IVR wiring was pulled, so
  Admin > Health Checks will go back to reporting the rota as not reachable from the IVR, correctly.
  Re-wiring needs the AMD false-positive addressed first: either tune
  `MachineDetectionSpeechEndThreshold`/`MachineDetectionSilenceTimeout` on that leg (untuned
  today — see the mobile-leg dial site), or drop `MachineDetection` entirely on the on-call leg and
  accept that a call to a genuinely-unreachable phone rings out instead of rescuing to business
  voicemail. Also worth revisiting then: on-call overrides `ring_my_mobile` unconditionally (by
  design, see the bullet above), which is what let the mobile ring at all despite Phill's own
  toggle being off — surprising in the moment even though it's working as documented.
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
- **The delivery caption under a message bubble has three rules, and the Messenger one is the
  counter-intuitive one.** Asked for as "what happened to the delivered". Nothing happened — until
  now both surfaces rendered ONLY a red "Not delivered" on `failed`/`undelivered` (#17,
  2026-09-02) and never a positive label, so a working thread showed nothing at all. The rule lives
  in `messageStatusLabel` (`mobile/src/lib/conversations.ts`) and in an identical `msgStatusLabel`
  in the web client JS (`src/html/pages/messages.ts`) — two copies, both pinned, because the two
  surfaces already drifted once on "was this call missed?".
  (1) A FAILURE shows on every failed message wherever it sits: a text that never arrived still
  matters ten messages later. (2) A POSITIVE label (`Delivered`/`Sent`/`Read`) shows only under the
  LAST outbound message, the way a phone's own Messages app does it — "Delivered" under every bubble
  is noise people learn to skip, the same reasoning as the self-clearing `divert_caller_id_last_error`
  and the deliberately narrow "unfinished" IVR badge. (3) **A Messenger thread gets NO positive
  label.** Facebook does not report delivery back the way Twilio's status callback does, so every
  Messenger message stops at `sent` PERMANENTLY — 13 of them in live D1 on 2026-09-12, newest from
  09-04 — and captioning those "Sent" forever would read as "not delivered yet" and be wrong every
  single time. A Messenger FAILURE still shows: that one is real, and is the 24-hour-window
  rejection the indicator was built for. Unknown statuses render NOTHING rather than defaulting to
  "Sent", so a status Twilio adds later is never captioned on a guess.
  The mobile row is its own component (`MessageBubble`) purely so the CALL SITE is testable:
  `@testing-library/react-native` cannot run here (it resolves `test-renderer`, which does not exist
  against the installed React — that is why `auth.test.tsx` is in `testPathIgnorePatterns`), so the
  test calls the function component directly with the theme hook mocked and walks the returned
  element tree. Deleting the caption block fails five tests; with the rule's unit tests alone it
  failed none.
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
  a live call. OTA 70 fixed two things with exactly that shape: the locked-phone launch that stuck on
  the auth spinner, and a lock-screen-answered call that never opened the in-call screen. If it does
  not recur after OTA 70, one of those was it. The iOS **crash loop of 2026-09-07** (app died within a minute of tab mount, over and
  over) was never root-caused either: it was escaped by rolling the OTA back to #49, and #53 carries
  the same code plus crash reporting and has been clean since. If it returns, `/admin/errors` is now
  the first place to look rather than the last.
- `reviewer@tcbpestcontrolcanberra.com.au` is a demo account that sits in the staff table marked
  `available`, but it is **excluded by code, not by luck**: `DEMO_ACCOUNT_EMAILS` in
  `wrangler.jsonc` feeds `demoEmails(env)` into `resolveRingTargets`, which drops it from the roster
  before shift or availability is even considered (and out of `/api/staff` likewise). An earlier
  note here claimed only a stale heartbeat kept it from ringing; that was wrong. Emptying that var
  is what would make it ring.
- **A ring node's `timeoutSeconds` has to beat the staff member's own carrier voicemail, or calls
  land there instead of business voicemail.** Reported 2026-09-15 as "calls are going through to my
  mobile voicemail, not the business". Live D1 had the SECOND `main` ring node (`n_e6wrtx7`, reached
  after the callback/continue gather) at **`timeoutSeconds: 500`** -- almost certainly a fat-fingered
  edit, since the mobile step editor's `NumberField` for this field has a `min` but no `max` (the
  web editor's `<input>` caps at 120 client-side only, never enforced server-side). At 500s, Phill's
  own mobile carrier answers the PSTN leg with his personal voicemail (typically ~15-20s) long before
  Twilio's own Dial timeout ever has a chance to fire -- and Twilio counts that as *answered*, not a
  timeout, so async AMD is the only thing left to notice and rescue the caller, 2-4s later, by which
  point the caller has already heard Phill's personal greeting. The FIRST `main` ring node
  (`n_5frbzxd`) was already at 15s and never showed this symptom in the event log -- proof that 15s
  reliably loses the race against the carrier before it can answer. Both `main` ring nodes are now
  15s. `isRingConfig`'s validator (`src/api/ivrFlow.ts`) now rejects any `timeoutSeconds` over
  `RING_TIMEOUT_MAX_SECONDS` (120, matching the web editor's unenforced client-side cap) from EITHER
  client, with a test that fails against the old code. The mobile `NumberField` itself was
  deliberately left alone: giving it a `max` risks the exact divergence bug documented on that
  component (a clamp that fires mid-typing, before the field is "finished") for a case the server
  now guards regardless of which client sends it.
- **Auto missed-call SMS, added 2026-09-15 (migration `0037`, `/admin/settings`, admin-only, OFF by
  default).** When a call ends having never produced an `answered` event, `sendMissedCallSmsIfDue`
  (`src/api/missedCallSms.ts`) texts the caller from the business number. It is hooked into
  `/webhooks/twilio/status` -- the CALLER's own top-level status callback, configured directly on
  the Twilio number, not `CallSession`'s per-ring-round `notifyMissedOnce` -- and that distinction
  is the whole design. A ring node's no-answer branch can lead to ANOTHER ring node (`main` has
  two), so `notifyMissedOnce` fires at the first round that times out, whether or not a later round
  bridges; hooking the SMS there would occasionally text a customer "sorry we missed you" while
  they were being connected. The status webhook only ever reaches this after the call is genuinely
  over (`ended_at IS NULL` already guards against a redelivered terminal status running it twice),
  so the auto-text can only ever answer "did anyone ever pick up, for the whole call" -- checked the
  same way `src/db/calls.ts` already defines "missed" elsewhere (`EXISTS ... event_type = 'answered'`),
  plus one addition: the call must have reached a `ring_started` event, or a wrong number who hangs
  up during the greeting gets texted too. Direction is checked too -- an outbound call (call-via-mobile)
  going unanswered is a staff member's target not picking up, not a customer TCB missed.
  `calls.missed_sms_sent_at` is claimed with an atomic `UPDATE ... WHERE missed_sms_sent_at IS NULL`
  **after** a successful Twilio send, not before -- claiming first would let a Twilio failure
  permanently mark a call "texted" when nothing went out, and nothing here retries a failure, so
  that mark would be a lie forever. The column is real belt-and-suspenders, not the primary
  guarantee: the caller already runs this at most once per call. The text itself is recorded via
  the ordinary `insertMessage`/`threadPeer` path so it shows up in that caller's inbox thread like
  any other message, in its own try/catch exactly like `handleSendMessage` -- Twilio has already
  accepted the send by that point, so a D1 failure there must never be reported as a send failure.
  Settings (`getMissedCallSms`/`setMissedCallSms`, key `missed_call_sms`) follow the exact
  `getDivertCallerId` shape: a JSON blob in the generic `settings` table, admin-only PUT, and a
  template capped at 320 chars (roughly two GSM-7 SMS segments) so an admin can't accidentally wire
  up a message that bills for a small novel on every missed call. Enabling it with a blank template
  is refused at save time, the same "validate on write" rule as everywhere else in this file.
  **Shipped web-only at first, which Phill caught within the hour ("I can't see it in settings" —
  he was on the app, not the browser).** Mobile now carries it too: `Admin > Missed-Call SMS`
  (`mobile/src/app/admin/missed-call-sms.tsx`), registered in `_layout.tsx`'s `ADMIN_SCREENS` and
  linked from the hub with an On/Off summary, the same shape as every other settings sub-screen
  (Business Hours, Call Blocklist). `getMissedCallSmsSetting`/`setMissedCallSmsSetting` in
  `mobile/src/lib/api.ts` mirror the web pair exactly. The lesson generalizes: **a business-wide
  admin setting shipped on only one of web/mobile is an incomplete feature, not a web feature** —
  check both surfaces before calling one done, the same rule already written down for the on-call
  rota's web/mobile split.
- **The missed-call SMS's first version only ever fired from `/webhooks/twilio/status`, so it
  silently never fired for the two cases Phill actually cared about.** Reported the same day as
  "sms not working if they request a call back or leave a voicemail". Both the voicemail `<Record>`
  handoff and `recordCallbackRequest` (`CallSession.ts`) set `calls.ended_at` **themselves**, the
  instant they run — well before Twilio's own terminal status callback for that call arrives — so
  by the time that callback lands, `ended_at IS NULL` is already false, `changes = 0`, and the
  status-webhook's own call into `sendMissedCallSmsIfDue` never runs. `sendMissedCallSmsIfDue` is
  now also called from both of those two call sites directly, each guarded the same way (`UPDATE
  ... WHERE ended_at IS NULL`, only call the hook if `changes > 0`) so a redelivered TwiML callback
  can't double-fire it.
  That fix alone would still have missed most real cases, for a second, independent reason: the
  async-AMD rescue (see the bullet on it above) makes Twilio report a real `answered` event for the
  call the moment ANY leg picks up — a staff member's own carrier voicemail included, since
  `AnsweredBy` isn't known until the separate async verdict lands 2-4s later (`handleAgentAnswer`
  only skips logging `answered` when it already knows synchronously it's a machine). So a caller
  rescued from a staff mobile's voicemail and then left a business voicemail carries BOTH an
  `answered` event and a `voicemail_left` event — and the original "ring_started AND NOT answered"
  rule read the `answered` event as decisive and skipped every one of these, which in live D1 was
  most of the real missed calls this feature exists for. `voicemail_left` and `callback_requested`
  are now decisive on their own regardless of what else is on the call, and a `no_answer` logged
  with reason `mobile_voicemail_answered` (the rescue fired but the caller hung up before recording
  anything) counts too. The plain "reached a ring, never answered" rule is now the fourth, narrower
  case, kept for exactly the reason it existed originally: a caller bridged on a LATER ring round
  must never be texted "sorry we missed you" mid-conversation, and none of the other three shapes
  will have fired for that call.
- **The app showed the BUSINESS number for every incoming call, never the customer's — a real bug,
  and it predates this session.** Reported 2026-09-15/16 as "it's showing the business number when
  calling in the app, not the customer's, wtf". Twilio's own `From` on a softphone (`client:`) leg
  is deliberately always the business number (`dialStaff` in `CallSession.ts`: caller-ID-ownership
  rules for a `client:` destination are murky, so the raw caller is never risked there); the ACTUAL
  caller rides along as a `CallerNumber` custom Client parameter instead, read via
  `CallInvite.getCustomParameters()` — Twilio's own documented mechanism for exactly this. Grepping
  the whole mobile app found **zero** references to `getCustomParameters` or `CallerNumber`: the
  backend had been sending it since the softphone shipped, and nothing on the client had ever read
  it. `voice.ts` used `invite.getFrom()` unconditionally in both places an incoming number is
  surfaced (`handleInvite` and the "already answered before JS subscribed" adopt path), so every
  ringing screen and every in-call screen (which take their number from the same route params) has
  shown "TCB Phone"/the business number since the softphone existed. Fixed with a `callerNumberFromInvite`
  helper that prefers the custom parameter (case-insensitive key match — no prior evidence either
  native SDK preserves case, and a customer's number is worth the defensive lookup) and falls back
  to `getFrom()` only when it's absent, run through `toE164` (the AU phone-number module already
  handled the backend's bare-digits shape correctly, per the comment left in `dialStaff` -- it was
  only ever unread, not unhandled).
- **1300/1800/13xx numbers could not be dialled from the softphone at all, and the fix for it
  already existed elsewhere in the codebase, unapplied to this path.** Reported 2026-09-16 as "i
  want to be able to call 1300 numbers". `normalizeAuNumber` in `worker.ts` (the gate in front of
  every softphone dial, `/twiml/voice-app`) only recognised `0[2-9]xxxxxxxx` geographic numbers and
  `61xxxxxxxxx`; a 1300/1800/13xx number typed the way anyone actually dials one ("1300 123 456", no
  leading 0 -- these carry no trunk prefix to strip) matched neither pattern and fell through to
  being returned as bare digits with **no `+` at all**, which Twilio rejects outright as not E.164.
  `callViaMobile.ts`'s `normalizeDialTarget` already carries the correct fix, with a comment naming
  this exact trap ("Slicing here produced +61300123456, a number that does not exist") -- it was
  only ever applied to the call-via-mobile path, never to the primary VoIP dial path these two
  functions otherwise mirror. `normalizeAuNumber` now matches it. `src/db/contacts.ts`'s
  `normalizePhone` (contact-matching only, unrelated to dialing) has the same gap -- a 1300 contact
  saved from one number shape won't match a lookup from another -- and was deliberately left alone
  here as a narrower, separate bug from "can't call the number at all".
- **Dialling a 1300/1800/13xx number is ALSO blocked by a Twilio ACCOUNT setting, entirely separate
  from the formatting bug above, and no code fix can clear it.** Even with `normalizeAuNumber`
  fixed, every attempt to `+611300669664` came back Twilio error **13227**: *"No International
  Permission. To call this phone number you must enable the High Risk:Special permission for AU"*.
  Twilio classifies AU 1300/1800/13xx destinations as **High Risk: Special** (a toll-fraud
  safeguard) and it is OFF by default, separately from ordinary AU mobile/landline permissions.
  Fixed 2026-09-16 by enabling it at
  `https://www.twilio.com/console/voice/calls/geo-permissions/high-risk?countryIsoCode=AU` (needs
  the account's Owner or Administrator role). Read Health Checks or the Twilio debugger for error
  13227/21215 before re-diagnosing this as a code bug again -- it looks identical to a formatting
  bug (the call is simply refused) but no amount of `normalizeAuNumber` correctness fixes it.
- **That geo-permission rejection was ALSO an unhandled crash in `/twiml/voice-app`, and Twilio's
  own retry turned one failure into two.** `createOutboundCall`'s throw on a Twilio 4xx/5xx had no
  try/catch on this route (unlike `callViaMobile.ts`, which already wraps the identical call) --
  so it escaped straight to the Workers runtime's own error page: a bare 500, logged in the Twilio
  debugger as **error 1101** ("Got HTTP 500 response to .../twiml/voice-app") with no explanation
  reaching the agent's own leg or the app. Twilio then retries that same webhook ONCE with the
  SAME CallSid, and the retry's `INSERT INTO calls` collided on the primary key with the row the
  first attempt had already written -- guaranteeing a SECOND crash regardless of what the first
  one was. Fixed with `INSERT OR IGNORE` (matching the pattern `recordCallLeg` already used for the
  same reason) plus try/catch around `createOutboundCall` and everything after it: a create-call
  rejection now marks the call `failed` and answers with `<Say>Sorry, that call could not be
  placed.</Say><Hangup/>` instead of a raw 500, and a failure AFTER the target call was already
  created best-effort cancels it rather than stranding the callee on a live call nobody joins.
  This is a general robustness fix -- it fires for ANY Twilio rejection (a rotated key, a 429, a
  different geo-permission gap), not just this one -- logged as `VOICE_APP_DIAL_FAILED` /
  `VOICE_APP_SETUP_FAILED` so the next one is a log line instead of a bare Cloudflare error page.

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
  falling over must be able to say so whoever holds it). Handsets are on **OTA 60**, and the first
  binary carrying the native CallKit fix is **build 5** (2026-09-10) — Settings shows both as
  `#60 · b5`.
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
  fields set throws in `renderHold`. **Anything new that reads or parses inside `startRing` joins
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
  beside the OTA number (`#60 · b5`) — that `b` half is what says whether the fix is on the handset,
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

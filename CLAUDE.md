# phone-system (tcb-voip)

VOIP phone system for TCB Pest Control Canberra: Twilio IVR call routing, SMS + Facebook
Messenger inbox, call history, a staff admin dashboard, and an Expo mobile softphone.

**THIS FILE IS THE PROJECT'S MEMORY -- the one place.** It loads into every session by itself;
nothing else does. In order:

1. **Rules checklist** -- every standing rule, one line each. Read it before any change.
2. **Status today** -- what is live, what is open, what is waiting on a person.
3. **Where things are** -- docs, skills, code layout, commands, standing constraints.
4. **Detailed notes, by topic** -- the incident behind each rule: what broke, how it was found, why
   the fix is shaped the way it is. The checklist names the topic; the heading finds it.
5. **Reference** -- how production, deploys, crons, routing and releases actually work.
6. **Repair log** -- every fix ever shipped, by date and PR number.
7. **History** -- superseded notes, kept for the record only.

`docs/superpowers/` (specs, plans, runbooks) and `mobile/AGENTS.md` are **background reading**, not
memory: read the spec for the area you are touching, but where they and this file disagree, **this
file wins** and the doc is stale. **Keeping this file true is part of every change**: a PR that
makes a line here wrong fixes that line in the same PR, and a new rule or repair is added here
before the work is called done.

## Rules checklist (read before any change)

**Working rules**
- Read this file, then the `docs/superpowers/specs/` doc for the area. Do not rediscover gotchas.
- Run `/code-review` BEFORE shipping, then review the fix, then the fix to the fix. The count of
  findings has repeatedly NOT fallen between rounds.
- Every regression test must FAIL against the reverted code -- revert and watch it fail. A test
  that reads source text, reads through a normalising read, sets `process.env.TZ`, or mutates the
  `env` from `cloudflare:test` (SELF.fetch never sees it) is not a test.
- Commit trailer `Co-Authored-By` YES, `Claude-Session` URL NO -- whatever a session reminder says.
- Never commit credentials: `mobile/credentials/`, `play-service-account*.json`, `*.keystore`,
  `*.jks`, `.dev.vars`. Say WHERE a secret lives; never paste its value.
- `git checkout -B <branch> origin/master` throws away unmerged commits on that branch. Check they
  are merged first.
- A business-wide feature or setting is not done until it is on BOTH web and mobile.
- Pull requests run no CI. `github-advanced-security` fails on every PR (GitHub's own Copilot
  `CAPIError: 400`); it is not a merge blocker and a session cannot re-run it.

**Database, deploy and release**
- Migrations: take the next number from `origin/master`, not your checkout (next free: `0043` as
  of 2026-09-27). Additive only -- `deploy.yml` applies them BEFORE the new code ships. Never
  rename one that has been applied (wrangler re-runs it); a duplicate number is survivable.
- D1 caps a query at 100 bound parameters and miniflare does not enforce it -- chunk any `IN (...)`.
- `call_events` timestamps are `ts`; `user_settings` is keyed by `email`. When unsure, read
  `SELECT sql FROM sqlite_master WHERE name = '<table>'`.
- `OTA_BUILD` lives in `mobile/src/lib/build.ts`; read it off `origin/master`, bump it before any
  publish, and never trust an unconflicted merge to mean the number is free.
- After any production EAS build, commit the new `buildNumber` in `mobile/app.json` (next iOS
  build is **6**). Every binary shares runtime `1.0.0`: an OTA that imports a new native module
  crashes older binaries -- bump `expo.version` for that.
- Native iOS code (`TwilioEarlyInit.swift`, plugins) ships only in a native build, never by OTA,
  and is unverified until an EAS build goes green.
- Expo is pinned to SDK 54 on purpose. iOS submit runs on EAS (`mobile/.eas/workflows/submit-ios.yml`);
  `mobile/eas.json` must NOT name `ascApiKeyPath`. Do not rebuild it as a GitHub Actions job.
- Store identifiers (`au.com.tcbpestcontrolcanberra.tcbphone`) and Play version codes are permanent.
  Store submission rules (screenshots, Play declarations, signing) are under "App Store and Play
  submission" in the detailed notes.
- Worker secrets are set with `npx wrangler secret put` -- `deploy.yml` sets none of them.
- `AUTH_MODE=dev` is local only, never production.
- `npm test` needs a Cloudflare login (the `ai` binding). Without one: copy `wrangler.jsonc` minus
  `"ai"` (the September plans' `localtest.sh` also dropped `send_email`) and point a throwaway vitest
  config at it; delete both after. Tests must seed the `staff_users` row first: `user_settings`,
  `sessions` and `password_tokens` have foreign keys to it and the test D1 enforces them. The full suite is flaky under
  load -- re-run failed files alone before investigating. `SELF.fetch` serialises requests, so a
  concurrency test must call the handler directly.

**Live calls -- the ring path**
- Nothing read inside `startRing` may throw: a throw hangs up on a live caller ("technical issue").
  Guarded today: `callerId`, `resolveRingTargets` (roster + prefs), `resolveNumberRouting`,
  `resolveOnCallEmail`, `playFromConfig`, the contact-name lookup, `recordCallLeg`,
  `holdCallbackAck`, `ringNoAnswerFromCall`, the `outbound_target_sid` read. Anything new joins.
- `cancelStaff` must swallow its errors; keep that tolerance inside it.
- `dialRound` holds other events while dialling -- keep anything that can throw OUT of it.
- Never make the queue hold document infinite (`<Play loop="0">`): the caller can never be released.
- Ring steps are **10s**. To ring longer, add another 10s step; never raise a timeout (the staff
  member's carrier voicemail wins the race). The server caps a ring timeout at 120s.
- AMD is ASYNC on the inbound mobile leg (redirect the caller out FIRST, then hang up the voicemail
  leg) and SYNCHRONOUS on call-via-mobile. Both are deliberate.
- A `<Dial action>` URL must answer TwiML, never a status endpoint's plain `ok`.
- Divert caller ID retries with the business number on **HTTP 400 only**.
- Every `client:` leg carries `CallerNumber` and `CallerName`, encoded with `encodeURIComponent`
  (never `URLSearchParams`), and never falls back to the business number. Deploy the worker before
  any OTA that reads a new key.
- Only the CALLER's leg records (`record-from-answer-dual`); staff legs pass `record: false`. Each
  flow declares `staffch=`. A reversed transcript is fixed at that flow's call site.
- Outbound rows store the BUSINESS number in `caller_number` -- branch on `direction`.
- Never put `CallerNumber`/custom parameters on a PSTN leg -- they only reach `client:` identities.
- Call Recording is ONE business-wide setting (`recording_enabled` in `settings`, default ON,
  admin-only PUT), read by `renderJoinConference`, `transfer-answer`, `mobile-bridge` and
  `CallSession`. Any new recorded flow must read it too.
- A voice number must be homed in **au1**, and so must every VoIP push credential (create those by
  REST on the au1 host; the Console cannot). Twilio webhooks authenticate by the `?whsec=` URL
  secret first -- rotate it primary=new/secondary=old, repoint, then unset.
- The ringback is self-hosted and exactly one 3.0s cycle; `/media/` is public and immutable-cached,
  so nothing private goes in that R2 bucket and a changed file needs a new name.
- A `<Conference waitUrl>` is played ONCE, then silence. Conferences wait on `/twiml/ringback-wait`
  (`CONFERENCE_WAIT_URL`), which loops the tone -- never point one at the bare audio file.
- The on-call rota stays UNWIRED from the IVR until AMD on that leg is tuned or removed. Its anchor
  must be a Monday.
- "Was this call missed?" is `answered`/`event_count` -- never `ivr_path` -- on every surface.

**Web dashboard and desktop app**
- Never let a dashboard navigation leave `/admin/phone`: the Twilio Device lives only there. Other
  sections open in the frame; one softphone per browser (Web Lock `tcb-softphone`).
- An outbound call shows its pane (with Hang up) the moment Call is pressed, not on `accept`.
- A status-line warning names what actually happened and takes itself back when it recovers. Only
  a 401 means signed out; a fetch that throws is the network.
- Status is per PERSON, not per device: nothing may set Offline automatically (an app quitting,
  unmounting or restarting). Quitting the desktop app did exactly that until 2026-09-28; the server
  now ignores that request (`isDesktopQuitOffline`), so the web Offline button must keep sending
  `{status}` alone.
- Inline scripts inside TS template literals: no backticks, no `${...}`, no regex with `\/`.
- Client escapers must escape quotes too (`h()`, `esc()`).
- Server-rendered admin times go through `formatSydney` (Workers run UTC).
- Mirrored copies change together: `msgStatusLabel`/`messageStatusLabel`, `msgTime`/
  `messageTimeLabel`, `normalizePhone` (three copies), `CALLBACK_KEYS` (web and mobile).
- Delete AND undo (threads and calls) are admin-only, and so is everything under `/api/admin/`.
- `/privacy` and `/terms` stay public, no auth -- both store listings and the app link to them.
- Auth keeps three properties: passwords of at least 10 characters, a dummy PBKDF2 run for an
  unknown email (so timing cannot reveal who has an account), and one neutral forgot-password page.
- Every new `/api/` route is checked against `handleDemoRequest`; `/api/admin/` is admin-only;
  `excludeEmails`-style exclusion lists are REQUIRED parameters, never defaulted.
- A desktop release is only for Electron shell changes: bump `desktop/package.json` and add a
  `releaseNotes.js` entry. Feature changes ship with the worker deploy.

**Mobile app**
- Read `mobile/AGENTS.md` before touching `mobile/`, and read the **SDK 54** Expo docs
  (https://docs.expo.dev/versions/v54.0.0/) -- newer docs describe a different API.
- Install mobile packages from inside `mobile/` with `npx expo install` (never hand-pick versions,
  never add app deps to the root `package.json`). A new ambient `@types/*` goes in
  `mobile/tsconfig.json`'s `types` list, which is `["jest"]`.
- Only `mobile/src/lib/voice.ts` imports `@twilio/voice-react-native-sdk`. Decision logic
  (`callRouting.ts` and friends) stays free of native imports so Jest can load it.
- An admin toggle whose server default is ON stays disabled until loaded
  (`toggleDisabled={value === null}`), or an admin "testing" it switches the feature off.
- `Icon` needs a `fallback` or Android shows a blank circle.
- Any screen that loads on `useFocusEffect` needs `keepEdits`, `setError(null)` on success, and a
  re-read before writing.
- `PUT /api/ivr/flows/:flow` is delete-and-reinsert: send every field back (`IVR_NODE_PUT_FIELDS`).
- `expo-application` must stay a direct dependency. `Alert.prompt` is iOS-only.
- Module state plus a timeout-less `apiFetch` wedges forever -- use a time window instead of a flag.
- A route group that is a sibling of `(tabs)` needs its own way back.
- Only a locked or killed handset tests VoIP push; a foreground app rings without it.

**Data writes**
- Validate on write, and name the offending entry in a JSON `{error}`: business hours, closed
  dates, blocklist (E.164), IVR nodes, ring timeouts. Check live D1 before tightening a validator.
- A callback may never erase what an earlier one recorded: recording fields are COALESCEd with
  `blankToNull`; a terminal message status is never overwritten by a non-terminal one.
- The conversation-undo token is an exact millisecond stamp: never re-read the clock, and never
  mutate hidden rows behind it.
- `handleGetDiagnostics` destructures its `Promise.all` by position -- add the binding with the check.

## Status today (2026-09-28 -- update this when it changes)

- **Live:** worker deployed 2026-09-28 (Deploy #175, #155; #153 and #154 went out earlier the same
  morning). Handsets on **OTA 82** (published
  2026-09-27, both channels). iOS **build 5** installed via internal TestFlight -- it **expires
  around 2026-12-09** and needs re-uploading; the next iOS build is 6. Android ships to the Play
  internal track. Desktop app 1.2.2 on desks; **1.2.3 is in the repo, not yet built or uploaded**
  (`cd desktop && npm run build && npm run release:upload` on a Windows machine).
- **Numbers:** `+61261059771` landline (default caller ID), `+61866108941` main (au1, no
  `phone_numbers` row), `+61485034869` SMS (voice disabled, us1).
- **Ring chain:** four 10s ring steps then voicemail, proven by a real call on 2026-09-27.
- **Shipped 2026-09-28** (none yet proven on a real call):
  - #153 -- web/desktop outbound calls show their screen and Hang up the moment Call is pressed.
  - #154 -- quitting the desktop app no longer sets the whole account Offline (a customer at 13:07
    went straight to voicemail with nobody rung). Desktop 1.2.3 removes the cause at source.
  - #155 -- the desktop's false "Session expired" is now "Connection dropped" and clears itself.
  - Outbound ringback: a desktop/web call rings "brr-brr" until the customer answers, instead of
    one odd ring and then silence (this change -- see the softphone notes).
- **Waiting on Phill (not code):**
  - Rotate the Twilio auth token exposed on 2026-09-10, if not done (order in the notes below).
  - Delete the dead secret: `npx wrangler secret delete TWILIO_INTELLIGENCE_SERVICE_SID`.
  - A second technician in `staff_users` -- today only Phill and the demo account.
  - File the unlisted App Store request (prep in `specs/2026-08-28-appstore-listing.md`).
  - Decide a retention period (nothing is ever purged today).
  - Decide on press-1-to-accept screening for the mobile leg (declined/off phones still leak 3-4s
    of carrier voicemail greeting).
  - Before ANY store submission: the App Store privacy answers and Play Data safety form say "no
    diagnostics / no crash SDK", but the app has collected crash reports (`client_errors`) since
    2026-09-08, and the privacy policy (`src/html/pages/legal.ts`) mentions neither those nor the
    fact that nothing is ever deleted. Update all three.
  - Confirm which Play developer account type TCB has: a personal account made after 13 Nov 2023
    needs a 14-day closed test with 12 testers before production.
- **Still unproven on a real call:** a call-via-mobile transcript (the one flow with reversed
  channels); the web shell's ring-while-on-Messages / Phone-mid-ring / Call-from-Messages cases;
  the #153 outbound pane on desktop.
- **Known, not yet fixed:** a greeting built as PLAY -> Hold (wait) -> ring never plays --
  `startRing`'s wait path uses only the Hold step's own audio and drops the PLAY before it (put a
  greeting before a DIRECT ring); the on-call rota is unwired from the IVR (AMD misfire); a ServiceM8
  `no-match` is never retried; a mobile business-hours save with an inverted window says only
  "request failed (400)"; most `Row` call sites lack an Android `iconFallback`; the `test` EAS
  profile cannot receive incoming-call pushes; the mobile "no hang-up button" report was never
  reproduced.

## Where things are

`docs/superpowers/` is background reading -- the approved designs and procedures. Read the one
for your area before implementing; where it disagrees with this file, this file wins.

- **`specs/`** — approved designs. Read the relevant one *before* implementing.
  - `2026-08-31-tenancy-foundation-design.md` — multi-tenancy, and the 7 sub-project roadmap to
    selling this to other businesses. **Shelved — not being pursued.** Kept for reference only; do
    not resume without Phill explicitly asking for it again.
  - `2026-08-27-tcbvoip-migration-design.md`, `2026-08-15-tcb-email-password-auth-design.md`,
    `2026-08-19-ios-softphone-phase1-design.md`, `2026-08-16-mobile-app-design.md` (+ phase2),
    `2026-08-27-settings-functional-design.md`
  - `2026-08-28-appstore-listing.md` / `2026-08-28-playstore-listing.md` — store listing copy,
    demo credentials, review notes, known review risks.
- **`plans/`** — task-by-task implementation plans, checkbox-tracked — but only the four
  2026-09-09 plans (delete-undo-hardening, divert-caller-id-regressions, tier2/tier3 review
  findings) are actually ticked. The August plans show 0 ticked boxes for work that shipped, and the
  Aug 27-28 ones carry "Historical plan — superseded" headers: an unticked box in a pre-September
  plan does NOT mean undone.
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

### Docs known to be stale (this file wins)

Found 2026-09-28; correct the doc if you are in it anyway.
- `specs/2026-08-27-tcbvoip-migration-design.md` and `runbooks/mobile-eas-first-build.md` call
  `phone.tcbpestcontrolcanberra.com.au` a live fallback route -- `wrangler.jsonc` has only
  `tcbvoip.app`.
- `specs/2026-08-19-ios-softphone-phase1-design.md`: says the deployed worker is not this repo
  (deploys run from `deploy.yml`), names one `TWILIO_PUSH_CREDENTIAL_SID` (it is `_IOS`, a secret,
  and `_ANDROID`, a var), and says a VoIP Services KEY (it must be a VoIP Services CERTIFICATE).
- Auth and mobile specs/plans: 12h sessions (code: 10 years), PBKDF2 210,000 (code: 100,000, the
  Workers cap), SendGrid (code: Cloudflare `send_email`), `tcb_session_token` (code: `_v2`), and
  "Expo SDK 57" in the phase-2 plan (the app is on 54).
- `runbooks/mobile-eas-first-build.md` blames an unexpected sign-out on "a different session
  secret" -- there is none; sessions are hashed D1 rows, so the causes are logout, a password reset
  or removal.
- The store specs disagree on the demo account (`offline`, `ring_priority=100` in one place,
  `available` in another; "verified 2026-08-28" in the Play spec, "created 2026-09-03" in the App
  Store spec). Check live D1 before relying on either. The App Store review notes also still say
  "small service businesses" / "subscribing business" from the shelved tenancy plan.
- The store privacy answers and `legal.ts` predate crash reporting (see Status today).

## Agent skills

`.claude/skills/` carries **committed copies** of the Superpowers (v6.4.1, MIT) and caveman
(v2.7.0, MIT skills only — not its BSL engine) skills, added 2026-09-24. Cloud sessions start in a
fresh container and never installed the plugins that `.claude/settings.json` enables, so the skills
were simply absent; project skills load in every session with no setup script. They are frozen
copies: to update, `claude plugin install` the plugin, copy its `skills/*/` folders (those with a
`SKILL.md`) back over, and `git add -f` — `.claude/skills/` is gitignored for `npx skills add`
junk, so a plain `git add` silently stages nothing. caveman's hooks and slash commands are not
included, only its skills.

## Layout

- `src/worker.ts` — Cloudflare Worker entry point; `src/{api,db,dial,ivr,twilio,facebook,push,
  email,access,html,durable-objects}/`
- `migrations/` — D1 SQL migrations, sequentially numbered
- `mobile/` — Expo app (TCB Phone). **Has its own `AGENTS.md` — read it before touching mobile.**
- `desktop/` — Electron wrapper. One window plus `requestSingleInstanceLock`; Task Manager showing
  ~6 "TCB Phone" processes is normal Electron (main, GPU, network, renderer, helpers), not duplicate
  instances — asked 2026-09-25.
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
The one check that DOES show up on a PR is GitHub's own **`github-advanced-security`**, and as of
2026-09-25 it fails on every PR with `CAPIError: 400 The requested model is not supported` — a
fault in GitHub's Copilot backend, not in the diff (#147 was docs-only and failed it). A session
cannot re-run it (403). It is not a merge blocker; do not chase it as a code failure.

**Querying live D1:** database id `c6d72eb4-9a3d-43cb-9678-69e5151b81fb` (also in
`wrangler.jsonc`). Two column names that are easy to guess wrong: `call_events` timestamps are
`ts` (there is no `created_at`), and `user_settings` is keyed by `email` (not `user_email`).
When unsure, read `SELECT sql FROM sqlite_master WHERE name = '<table>'` first.

## Standing constraints (detail)

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
- **There is NO tenancy in the code or the database.** This line used to say `tenant_id` columns
  exist and `tnt_tcb` is hardcoded in migration `0026` — false (audited 2026-09-27): no tenant
  table, no `tenant_id` column and no `tnt_tcb` anywhere in `src/`, `migrations/` or live D1, and
  `0026` is `0026_message_delivery_errors.sql`. The tenancy migration from the shelved plan was
  never committed; `plans/2026-08-31-tenancy-foundation-part1.md` saying it "DID land" is wrong too.
  If tenancy is ever revived, the fail-closed rule stands: `tenant_id TEXT NOT NULL DEFAULT ''`,
  never defaulted to a real tenant.
- **Check `ls migrations/` before adding one — against `origin/master`, not your checkout.** Another
  session may have taken the next number, and a stale clone answers the question wrongly while
  looking like it answered it. That happened on 2026-09-21: a session sitting three commits behind
  (`167229f`, #128) listed `migrations/` correctly for what it had, saw `0040` as the last, and
  added `0041_per_number_ivr_flow.sql` — while `0041_reset_legacy_transcript_status.sql` already
  existed on master from #130. Both are on master now.
  `git fetch origin master && git ls-tree --name-only origin/master migrations/ | tail` is the
  check that would have caught it.
  **Two migrations sharing a number is survivable, and renaming one after it has been applied is
  not.** wrangler tracks applied migrations by FILENAME, so the two are distinct entries, both run,
  ordered lexicographically (`per_number` before `reset_legacy`) — and these two touch different
  tables, so the order does not matter. Renaming one to `0042` after production has applied it would
  make wrangler treat it as new and re-run it, and an `ALTER TABLE ... ADD COLUMN` run twice fails
  on `duplicate column name`. So: leave a duplicate number alone once deployed, and take the NEXT
  free number for whatever comes next (`0042_message_media.sql` has since taken `0042`, so as of
  2026-09-27 the next free number is `0043` — check `origin/master` anyway).
- **`OTA_BUILD` collides the same way, and git will NOT warn you.** #131 bumped it 76 -> 77 and
  PUBLISHED 77 (run #39, 2026-09-21 11:08). #132, branched from #128 where it was 76, bumped
  76 -> 77 as well — and because both sides ended on the same literal, there was no merge conflict
  at all. Master carried `OTA_BUILD = "77"` with mobile changes the published 77 does not contain,
  so publishing would have put materially different code on handsets under a number already in use.
  That is the one thing the version label exists to prevent: it is how anyone answers "what is on
  that phone?". Bumped to 78 before any publish. **Read `OTA_BUILD` off `origin/master`, never off
  your checkout, and never assume an unconflicted merge means the number is free.**
- **Commit trailers: `Co-Authored-By` YES, `Claude-Session` URL NO.** The repo convention is stated
  in four places under `docs/superpowers/plans/` and in
  `specs/2026-08-27-tcbvoip-migration-design.md` ("Do not include the Claude-Session URL trailer").
  A Claude Code session reminder may say to add both; the repo's own rule wins, and that reminder
  says so itself. Written here because it was missed on 2026-09-21 by a session that had READ those
  plan files earlier the same session — a rule filed only in the plans is a rule that gets walked
  past. The trailer is in `3fddcf2` on master as a result; it was left there rather than
  force-pushing shared history to remove it.
- `AUTH_MODE=dev` bypasses staff login. Local development only, never in production.

## Detailed notes, by topic

The incident behind each rule in the checklist: what broke, how it was found, and why the fix
is shaped the way it is. Newest status is in **Status today** above; these are the reasons.

### Phone numbers, regions and app distribution

- **iOS: internal TestFlight TODAY, unlisted App Store INTENDED.** Keep the two apart — this file
  recorded only the first and `specs/2026-08-28-appstore-listing.md` only the second, so each read
  as the settled answer and they disagreed. Both are true, at different dates (reconciled
  2026-09-23).
  *Today:* staff install through **internal** TestFlight testers, who skip Beta App Review entirely.
  Builds expire after 90 days, so this needs a re-upload quarterly. TestFlight **external** testing
  was **rejected under Guideline 2.2** — TestFlight is for apps bound for public distribution, and
  this is a single-business staff tool — and a public App Store listing would hit **Guideline 3.2
  (Business)** for the same underlying reason.
  *Intended:* **unlisted** App Store distribution (decided 2026-09-03), which is on the real App
  Store but invisible to search, charts and categories, installs from a direct link, auto-updates
  and never expires. **The unlisted request has not been filed or approved**, so none of it is live;
  `specs/2026-08-28-appstore-listing.md` is the prep for that submission, including the review-notes
  wording, which for unlisted says the staff-only audience OUTRIGHT rather than dodging 3.2.
  The other durable option is an Apple Business Manager custom app, which needs a Company/
  Organization account with a D-U-N-S — this enrolment is individual (Team ID B7WRQ9STH6), so it is
  closed without converting. Note that choice is one-way per app record and tenancy sub-project 7 is
  a public App Store submission — so do not set this bundle ID to Private if it is meant to become
  the public product.
- **Android:** ships to the Play **internal** track via `eas submit`.
- **Backend:** single-tenant, TCB-only. The multi-tenancy plan is shelved (see `specs/` note above)
  — this stays a TCB-specific tool for now.
- **Numbers:** `+61866108941` (au1, main line) and `+61485034869` (us1, SMS + voice). The Canberra
  landline **`+61261059771` ("6105 9771") ported in on 2026-09-03** and is now the default caller
  ID. Setting one up is two separate steps: the Twilio console webhooks (from `/admin/webhooks` —
  the `?whsec=` IS the auth) and a `phone_numbers` row on `/admin/settings`. The app never touches
  Twilio's number-provisioning API, so adding the row configures nothing on Twilio's side, and
  inbound routing reads that table for ONE thing only -- which IVR flow the call enters (see the
  per-number routing bullet below). Everything else about how a number behaves still lives in the
  Twilio console.
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
  against live D1 on 2026-09-06). That did NOT stop it taking a call: on 2026-09-18 a leftover
  Twilio voice webhook sent one in, the us1 call failed an au1 redirect with a 404, and both sides
  heard "technical issue" (#123). `CallSession` now answers `<Reject reason="rejected"/>`
  (`VOICE_DISABLED_NUMBER`) for any number whose row says `voice_enabled = 0`; it fails OPEN for a
  number with no row or a failed read. `+61866108941` has no `phone_numbers` row at all.
  Re-check its region before ever turning voice back on.

### Inbound routing and the ring path

- **Every number can have its OWN IVR, and that is a property of `phone_numbers` (migration `0041`).**
  `ivr_flow` and `after_hours_flow` are nullable columns; NULL means "follow the shared default"
  (`main` in hours, `after_hours` outside them), which is exactly what every number did before, so
  existing rows are unchanged. They are deliberately NOT defaulted to the literal `'main'`: a stored
  name would pin a number that was never configured, and would make "never set" indistinguishable
  from "deliberately set to main". `src/ivr/numberRouting.ts` resolves it, and two things in there
  are load-bearing. It **must never throw** -- it is read inside `handleMainWebhook`, and a throw
  there escapes to the DO catch-all, which says "we're experiencing a technical issue" and hangs up
  on a live customer (the same family as `callerId()` and `resolveRingTargets`); a failed read falls
  back to the defaults. And it is **ONE read**: it replaced `isVoiceDisabled` rather than sitting
  beside it, because both wanted the same row and a live caller should not wait on two round trips
  to find out which greeting to play. A blank stored value is treated as NULL -- `""` is not null,
  and `?? DEFAULT` would hand `loadEntryNode` a flow that cannot exist.
  **The fallback CHAIN is the design, not politeness.** `entryFlowCandidates` returns
  `[number's flow, "main"]` in hours and `[number's after-hours flow, "after_hours", "main"]` after
  them, deduped, and CallSession tries each in turn. An admin who points a number at a menu and then
  deletes that menu's starting step would otherwise hang up on every caller to it; instead they hear
  a working menu and `Admin > Health Checks` goes red (`checkNumberRoutes`). Only a broken `main`
  reaches the catch-all, which is what happened before this feature existed and is the one case with
  nothing left to fall back to. With no overrides the list is byte-for-byte the old behaviour -- a
  test pins that, because changing routing for every existing call would be the worst possible way
  to add this.
  **Every rung is MORE GENERIC FOR THE SAME SITUATION, never a sideways move**, and that rule is
  what keeps the after-hours chain off the number's own DAYTIME menu. This paragraph described that
  sideways rung as the design until 2026-09-23 -- it was written before `/code-review` removed it
  (see the review note further down this bullet) and never reconciled when the code changed, so the
  file contradicted both itself and `src/ivr/numberRouting.ts` for two days. Anyone adding a rung
  here: `entryFlowCandidates` is the only place the order lives, and its own comment carries the
  same rule.
  Pointing a number at a flow with no entry node is **refused on write** (`/api/numbers`, JSON error
  naming the field and flow, since `apiFetch` lifts a message only out of `{error}`); only a
  non-null value is checked, so no existing row can become unsaveable. The remaining way to break it
  is deleting or renaming a menu a number still points at, which no write to `phone_numbers` sees --
  hence the Health Check.
  **Three places had to stop assuming there were only two flows.** `isRingNodeReachingOnCall` now
  takes the per-number after-hours candidate lists (a rota wired only into a second line's menu read
  as unwired before, and one wired only into `after_hours` read as fine for numbers that never enter
  it); it takes them REQUIRED, not defaulted, for the same "a defaulted list fails open" reason as
  `excludeEmails`. `GET /api/ivr/flows` lists every flow with `hasEntry`, so both pickers offer real
  menus instead of a free-text box. And the mobile **Phone Menu** screen grew a flow switcher --
  without it you could point a number at a menu on the handset that only the web could then edit,
  which is the "shipped on one surface only" half-feature this file already warns about twice.
  The mobile step editor takes the flow as a route param: it PUTs the WHOLE flow back under that
  name, so a wrong one would wipe the other menu. What makes that safe is the existing load guard --
  a node that is not in the loaded flow errors out instead of becoming a save.
  **`addStepTo` makes the new step the ENTRY when the menu has none** (and only then -- moving an
  existing entry stays refused on mobile). Without it a brand-new menu could never get its first
  step from the handset and an entry-less one could never be repaired, because `handlePutFlow`
  requires an `entryNodeId` matching a node: every save and delete died on the opaque
  `invalid request body`. The web editor has always done the same thing (its entry falls back to
  `nodes[0]`), so this is parity. A menu is created by switching the Phone Menu screen to a new name
  and adding a step -- there is no table to insert into. The name field is an inline `TextInput`,
  **not `Alert.prompt`**, which is iOS-only: on Android it is simply absent at runtime, so creating
  a menu would have been impossible on the platform nobody tests on.
  **`/code-review` before shipping found three defects in the first version, all of which would have
  been live.** (1) `checkNumberRoutes` failed on the RESOLVED flow, so a business whose shared
  `after_hours` menu lacked a starting step was reported broken -- the exact state the fallback
  chain exists for, i.e. red over a working system. It has three levels now: **fail** only for a
  flow an admin EXPLICITLY set (`routesInUse` carries the raw nullable value beside the resolved
  one, so the two can be told apart), **fail** when no rung of the chain can answer at all, **warn**
  when an unset default is unusable but the chain covers it. (2) The after-hours chain had the
  number's own IN-HOURS flow as a rung, which would play a 2am caller that line's daytime menu where
  pre-0041 code used `main`'s closed branch -- every rung must be more generic for the SAME
  situation, never a sideways move. (3) The mobile flow switcher let you select an entry-less menu
  that then 400'd on every save, with no way to fix it on the handset -- which is what the
  `addStepTo` change above closes. The count did not fall between finding and fixing: review the
  fix, then review the fix to the fix.
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
- **Reads on the ring path must never throw, and that list is the thing to check.** (Headed "THREE"
  once; it is well past that. Added since: `resolveNumberRouting` `NUMBER_ROUTING_LOOKUP_FAILED`,
  the contact-name lookup `RING_CONTACT_LOOKUP_FAILED`, `recordCallLeg` `CALL_LEG_RECORD_FAILED`,
  `holdCallbackAck` `HOLD_CALLBACK_STEP_UNUSABLE`/`_FAILED`, `ringNoAnswerFromCall`
  `AMD_FALLTHROUGH_LOOKUP_FAILED`, and the `outbound_target_sid` read in `handleAgentStatus`
  `AGENT_STATUS_OUTBOUND_LOOKUP_FAILED`. Refer to them by function name — line numbers here rot.) A throw
  inside `startRing` escapes `handleMainWebhook` to the DO's catch-all, which says "we're
  experiencing a technical issue" and **hangs up on a live customer** — via `performDeferredDial`, on
  someone already waiting on hold. `callerId()` was fixed for this (#71); `resolveRingTargets` sits
  one line away (in `startRing`; the old `CallSession.ts:402` reference is stale) and had the same exposure twice over — `getStaffRoster`
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
  **It regressed, and 15s stopped being enough (2026-09-25).** `n_e6wrtx7` was back at **60s** and
  Phill's carrier voicemail answered ~32s into it; on the same day it also answered at **14.4s** into
  the 15s first round, so the carrier's timer varies and 15 is no margin at all. Every `main` ring
  step is now **10s**, and the old single long ring is a CHAIN of short ones:
  greeting -> ring 10 (`n_5frbzxd`) -> hold/callback (`n_holdcb1`) -> ring 10 (`n_e6wrtx7`) ->
  ring 10 (`n_ring03`) -> ring 10 (`n_ring04`) -> voicemail (`n_pkqmsmd`). Each ring step is a new
  leg, which restarts the carrier's no-answer timer, so it never reaches its own voicemail. Written
  straight to D1 at Phill's request. **To ring longer, add another 10s step; never raise a timeout.**
  What this cannot fix: a DECLINED call or a phone that is off goes to carrier voicemail instantly,
  and the caller still hears 3-4s of the personal greeting before async AMD rescues them. The cure
  for that is press-1-to-accept screening on the mobile leg, offered and not yet chosen.
  **Proven with a real call on 2026-09-27 07:46 Sydney** (`CA248f1a7612c4b9a6e4a43780980ed1f4`,
  Phill's mobile to the landline, left unanswered): four `ring_started`/`no_answer` rounds at 16s,
  29s, 48s and 61s (each round lasted 12-19s, since Twilio's setup time adds to the 10s timeout), then
  `voicemail_left` in "Voicemail during hours" at 90s, with NO `mobile_machine_answered` — the
  carrier voicemail never got in. Re-run that same `call_events` check if this ever regresses. Phill has ring-my-mobile ON, so his leg is the
  PSTN mobile, which is why his carrier voicemail is in the race at all.

### Ring-my-mobile, divert caller ID and call-via-mobile

- **Ring-my-mobile is a DIVERT**, decided 2026-09-02: when a staff member enables it, their leg
  becomes their mobile and their softphone is **not** rung. Per-person — other staff still ring.
  This deliberately supersedes the "additive / also ring" wording in
  `specs/2026-08-27-settings-functional-design.md`; read the Superseded note there before "fixing"
  it back. Each on-shift person contributes exactly one leg, which is also what keeps
  `ring_priority` ordering meaningful under the cascade strategy.
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

### After-hours on-call rota

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

### Softphone calls: hold, transfer, dialling out

- **An outbound softphone call played ONE ring and then dead air until the customer answered
  (2026-08-23 to 2026-09-28).** Reported as "it doesn't bring-bring, it has a weird dial and then
  goes quiet". The agent's leg joins the call's conference first and waits there alone -- a
  conference does not start until two participants are in -- hearing its `waitUrl`. That was the
  wav itself, on the belief that "Twilio loops the file itself". It does not: Twilio's `<Conference>`
  docs say a waitUrl's content runs once "and then silence will be played"; the only loop is TwiML.
  So the 3.0s file played one cycle (the "weird dial") and nothing followed. The same waitUrl is on
  the inbound caller's `renderJoinConference`, so a caller waiting for the staff leg to join got the
  same silence, only for less time. Fix: every conference waits on `CONFERENCE_WAIT_URL`
  (`/twiml/ringback-wait`, public and static, GET or POST), which answers `<Play loop="0">` of the
  same file. The unbounded loop is right here and ONLY here -- conference wait audio stops when the
  conference starts, whereas the queue hold document must end so the caller can be released. The
  Voice SDK's own short "connecting" chirp when Call is pressed is separate and was left alone.

- **Hold, transfer and complete-transfer resolve the conference from the staff member's OWN leg**
  (`ownLegConference`, `softphone_call_legs.conference_name`). A client-supplied `conferenceName` is
  ignored: an inbound call's conference is named after the CALLER's leg, which no client knows, so
  web Hold 404'd on every inbound call and mobile Hold only ever flipped local state. Complete-transfer
  removes **only the requester's own leg** (it used to remove any `callSid` it was given, i.e. a staff
  member could hang up the customer) and refuses with 409 until the colleague has joined, or the
  lone-conference cleanup ends the call on the customer. Mobile transfer is **attended only**; Blind
  was removed deliberately, because an unanswered blind transfer strands the customer alone.
- **Outbound calls store the BUSINESS number in `caller_number`.** Both outbound paths bind it that
  way and the customer's number is `called_number`, so anything identifying "the customer" has to
  branch on `direction` -- reading `caller_number` unconditionally told Twilio the office landline
  was the customer.
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
  shown "TCB Phone"/the business number since the softphone existed. Fixed with a helper (first
  `callerNumberFromInvite`; since #127 it is `callerFromInvite`, returning `{number, name}` from the
  `CallerNumber` and `CallerName` parameters) that prefers the custom parameter (case-insensitive key match — no prior evidence either
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

### Recordings and transcripts

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
  channel 1 is STAFF. It records dual anyway and says so with `staffch=1` (next bullet).
  **The softphone mapping is now CONFIRMED against a real transcript** — call
  `CA5cf27e3ccfe07f91d6046b9c746d41a5`, 2026-09-22 07:18, the first labelled transcript this system
  has ever produced: the dialled party came out as `Customer:` and the staff member as `Staff:`,
  correctly. It had only been inferred from Twilio's documented rule until then, and this repo was
  burned once before trusting exactly that reasoning, so it needed reading. **Call-via-mobile has
  NOT been read yet** and is the one flow with the opposite mapping — the only one left that could
  come out backwards.
  That same transcript settled the other open question: **Workers AI
  `whisper-large-v3-turbo` does return per-segment timings**, so transcripts interleave into a real
  back-and-forth. The one-block-per-speaker form in `buildLabelledTurns` is the safety net for a
  model that stops returning them, not the normal output.
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
  **[Stale 2026-09-27: the sweep is gone; the setting is now read in the recording-status webhook, only when the call has no `staffch` and the recording is dual.]**
  The SETTING is read in **exactly one place**: the sweep, at collection time
  (`intelligenceQueue.ts`), and only when the call carries no per-call value. The recording-status
  webhook used to read it too, to label the channels in the transcript CREATE — that went with the
  `participants` array, since Twilio refused the request that carried it. So Twilio's own
  participant roles are never set and never read; the labels in `call_transcript` come from the
  per-call value or this setting, nothing else. `getTranscriptStaffChannel` still **catches `JSON.parse`**, because a hand-edited
  junk row would otherwise throw inside the cron tick. The first test for that seeded `'7'` — valid
  JSON, so the guard was never executed and deleting it left the test green.
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

### Missed calls, voicemail and the missed-call SMS

- **A voicemail is a call with a `mailbox_label`, NOT one with a transcript.** The mobile Inbox
  filtered on `transcription`, so every message Whisper produced nothing for was invisible — which
  is most short ones; both voicemails left on 2026-09-08 (4s and 5s) had `transcribe_attempts`
  exhausted at 3 and `transcription` NULL while sitting playable in D1. `mailbox_label` is written
  only by the voicemail path (`CallSession.ts`, beside the `voicemail_left` event); every recording
  in production without one carries an `answered` event, i.e. is a recorded conversation. Fixed in
  #61; `/admin/voicemail` (added in #60, restyled in #62) uses the same rule.
- **"Was this call missed?" has ONE definition, and it is `answered`/`event_count`, not `ivr_path`.**
  `listCalls` ships both columns for this. The web softphone kept the older `!ivr_path` rule long
  after the handset moved (#65), and `CallSession` writes `ivr_path` on the voicemail handoff — so
  **no call that reached voicemail was ever marked missed on the web**, which is exactly the set
  that still needs ringing back. Both surfaces now answer it identically; change them together.
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
  **BEFORE** the Twilio send and set back to NULL if the send throws (changed in #138; this bullet
  said "after" until 2026-09-27). The reason: there are now two senders that can race (next
  bullet), and the conditional UPDATE is the only thing that serialises them. Releasing on failure
  keeps the column honest ("a text actually went out"). The caller ID is resolved BEFORE the claim,
  because a throw between claim and try would hold the claim forever. The same UPDATE also enforces
  **one text per caller per Sydney day** (#148, `NOT EXISTS` another call from that caller with
  `missed_sms_sent_at >= sydneyDayStart(now)`; skips log `MISSED_CALL_SMS_SKIPPED`). It reads
  `calls`, not `messages`, because the messages insert is best-effort. Known edge: an in-flight
  claim counts, so if that send then fails, a second call from the same number ending in the same
  second stays untexted. The text itself is recorded via
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
  status-webhook's own call into `sendMissedCallSmsIfDue` never runs. The first fix called it from
  both IVR sites directly — which texted callers while they were STILL ON THE LINE, mid-voicemail.
  **Current design (#138, superseding that):** exactly two senders. (1) The caller leg's terminal
  status callback, deliberately OUTSIDE its `changes > 0` block, so an earlier `ended_at` stamp no
  longer suppresses it. (2) CallSession's `<Record>` action, ONLY when Twilio posts
  `Digits=hangup` (the caller hung up to end the recording); any other value means they are still
  connected. Sender 2 exists because the two fire concurrently with no ordering, and if the status
  webhook lands first `voicemail_left` is not written yet. `recordCallbackRequest` no longer stamps
  `ended_at` itself; it waits for its recording like voicemail. Two code comments still describe
  the old shape (`missedCallSms.ts` "Called from ONE place", `worker.ts` "the ONLY place") — trust
  the code, not them. Also: this whole feature leans on the per-number **"Call status changes"**
  webhook being set in the Twilio console, which `/admin/webhooks` labels only "optional but
  recommended"; `reconcileStaleCalls` stamps `ended_at` but never sends the text.
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

### ServiceM8

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

### Messaging: SMS and Facebook Messenger

- **Message threads are keyed by `threadPeer`**, which normalises only phone-shaped strings
  (`0412 345 678` -> `+61412345678`) and leaves Messenger ids and alphanumeric senders ("Service NSW")
  untouched. Sending normalised but lookup did not, so a new message showed an empty thread.
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

### Auth, staff accounts and the demo account

- **The App Review demo account is denied by default on `/admin/`**, except `/admin/phone` and
  `/admin/messages`, which render from the substituted `/api/`; everything else read real D1 and a web
  login lands on `/admin/live`. Its `POST /api/push/register` is swallowed too, since every push goes
  to every stored token with real customer names and message text.
- **The login lockout is `reserveAttempt`: one conditional INSERT before the password hash.** Count,
  hash, then record let a parallel burst all pass the count (20 of 20 in the test). A success clears.
  **`SELF.fetch` serialises requests in the test worker, so a concurrency test must call the handler
  directly**; the SELF version of this test passed against the broken code.
- **Removing a staff member is a MULTI-TABLE cleanup, and the handset is the part people forget.**
  `handleRemoveStaff` clears sessions, `password_tokens`, `login_attempts`, `push_tokens` and
  `user_settings` before deleting the row. Before migration `0039`, `getPushTokensForType` selected
  every row in `push_tokens` and never checked the owner still existed, so a missed delete left a
  departed person's phone showing inbound customer texts indefinitely. Since `0039` every sender
  reads through `LIVE_PUSH_TOKENS` (`src/db/pushTokens.ts`), which joins `sessions` on
  `push_tokens.session_hash` — so logout, a password reset or removal stops that handset's pushes.
  A pre-0039 row with NULL `session_hash` stays live only while `last_seen` is under 30 days old.
  Health Checks and Test Push must use the same clause or they call a phone fine that real pushes
  skip. The
  `user_settings` row matters for the opposite reason: without it a re-invite silently restores the
  old mobile number and ring-my-mobile state onto whoever next holds that address.
- **A completed password reset invalidates the account's OTHER tokens and its lockout.**
  `issueToken` always INSERTs, so two clicks of "Send reset" leave two live links; consuming one
  used to leave the other valid for the rest of its hour, and whoever held the older email could
  set the password again afterwards and take the account. `login_attempts` is cleared in the same
  place, or someone who hit the 8-failure lockout and then legitimately reset was still refused on
  the next login.
- **A defaulted exclusion list FAILS OPEN, so security-shaped parameters are required ones.**
  `excludeEmails: string[] = []` meant a new caller — or a route refactor dropping `demoEmails(env)`
  — compiled cleanly and silently restored the demo account to the pickers. Both the on-call
  handlers and `/api/staff` take it required now, so omitting it is a type error. `/api/staff`
  matters more: it is the UNGATED roster the softphone's transfer picker reads, where an App Review
  reviewer appearing as a destination could be handed a real customer's live call.
  The filter itself is **one function**, `excludeDemos` in `src/demo`. It existed as three
  byte-identical copies, and the single surface that skipped it (`checkOnCall`) is exactly where
  the bug turned up.
- `reviewer@tcbpestcontrolcanberra.com.au` is a demo account that sits in the staff table marked
  `available`, but it is **excluded by code, not by luck**: `DEMO_ACCOUNT_EMAILS` in
  `wrangler.jsonc` feeds `demoEmails(env)` into `resolveRingTargets`, which drops it from the roster
  before shift or availability is even considered (and out of `/api/staff` likewise). An earlier
  note here claimed only a stale heartbeat kept it from ringing; that was wrong. Emptying that var
  is what would make it ring.

### Admin settings and Health Checks

- **Admin > Health Checks (mobile) is where "is it actually working?" gets answered.**
  `GET /api/admin/diagnostics` runs eleven checks as of 2026-09-27 (display order: twilio, regions,
  number_routes, roster, on_call, divert_caller_id, servicem8, transcripts, email, voip_push, push),
  each one added because it failed silently in production. The original six: Twilio credentials, **live** voice-number regions (asks `routes.twilio.com` rather
  than trusting the region recorded on `/admin/settings` — a 404 there means no explicit config,
  which defaults to us1), who is on call right now, ServiceM8 (distinguishing "no key" from "key
  rejected"), the email binding, and the caller's registered push devices. `POST
  /api/admin/test-push` and `/api/admin/test-email` are end-to-end and deliberately target only the
  CALLER's own account, so a test never pages the team; the push one prunes any token Expo reports
  as `DeviceNotRegistered`.
- **`handleGetDiagnostics` positionally destructures its `Promise.all`.** Adding a check without
  adding a binding shifts every one after it and drops the last off the end silently. That happened
  when the transcripts check was added: the push check vanished while every other assertion still
  passed. A test now pins the exact key list.
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

### Web dashboard and desktop app

- **"The desktop session keeps expiring every couple minutes" was a false alarm that never cleared
  (2026-09-28).** The session was fine: no new `sessions` row, no failed logins, sessions last 10
  years, and `last_heartbeat_at` was seconds old. The Phone page beats every 20s; two beats whose
  `fetch` THREW -- a network blip, never the session -- printed "Session expired -- reload", and a
  later successful beat only reset the counter, so the text stayed up for good. Now: a throw reads
  "Connection to the server dropped -- retrying…", only a 401 reads "Signed out", and the next
  successful beat takes back its own warning (only its own -- a Device error shown since stays).
  The token-refresh catch no longer says "session expired" either. `test/html/phoneHeartbeat.test.ts`
  runs the real emitted code. If the warning keeps coming BACK, the desk's network is dropping --
  and with ring-my-mobile ON, Phill's inbound leg is his mobile, not this page, anyway.

- **Quitting the desktop app set the whole account Offline, and that is why calls went straight to
  voicemail (2026-09-28).** A customer rang at 13:07 and the log showed `call_started` then
  `voicemail_left` with NO `ring_started`: the ring step found nobody and fell through. Phill's
  `status` was `offline`, set that day -- his 12:48 call had rung, so it changed in between, and the
  desktop heartbeat reappearing at 13:08 fits the app being quit and reopened (the #153 deploy went
  out at 13:03). `desktop/main.js`'s `before-quit` PUT `{status:'offline',awayReason:null}` "so the
  roster drops this agent instead of ringing a dead endpoint" -- a reason that died when the
  heartbeat stopped gating ringing. Status is per person, so it took his MOBILE off the roster too,
  for the rest of the day (the morning reset only clears earlier days). The handset had already
  learned this ("closing the app is not going off shift"); the desktop never had.
  Two halves. The shell change needs a desktop release (1.2.3), so the server ignores that exact
  request NOW: `isDesktopQuitOffline` matches a UA containing `Electron/` AND a body of exactly
  `{status:"offline",awayReason:null}`, answers `{ok:true,ignored:true}` and logs
  `PRESENCE_DESKTOP_QUIT_IGNORED`. The web Offline button was changed to send `{status}` alone so it
  never matches (Offline clears an away reason either way); the handset already sends `{status}`
  alone. One edge: a desktop page loaded BEFORE the deploy still sends the old body from its Offline
  button, which is ignored until that page reloads.
  Diagnose any "it went straight to voicemail" the same way: no `ring_started` means zero targets,
  so read `staff_users.status`, `status_set_on` and the schedule before anything else.

- **Call History was removed from the web dashboard (#63).** The handset carries the same list. The
  per-call DETAIL page `/admin/calls/:id` stays — `/admin/voicemail` links into it — but
  `/admin/calls` 404s deliberately, and a test pins that.
- **A web/desktop outbound call shows its pane the moment Call is pressed, not on `accept`
  (2026-09-28).** Reported from the desktop app as "no calling screen" -- and a call sitting in the
  customer's voicemail had no Hang up at all. The pane (the ONLY Hang up) used to appear on the
  SDK's `accept` event and nothing before it. Two live calls that day (12:48, 12:49, both into the
  customer's voicemail) connected with no screen; WHY `accept` never showed it was NOT found --
  SDK 2.18.3 emits it once media and signalling are open, which a `<Dial><Conference>` answers at
  once. So the fix does not depend on it: `placeCall` shows `showCallPane(to, true)` ("Calling",
  Hang up only -- Mute/Hold/Transfer need the leg's CallSid) before `device.connect`, Hang up while
  connecting sets `hangupWhenPlaced`, and a failed connect takes the pane down. `placeCall` and
  `callContact` refuse while `callBusy()`, or the failure path would tear down a live call's pane.
  A rail **"On call"** button now brings the pane back after Calls/Contacts/dial pad replaced it --
  before that nothing did. Still unproven with a real desktop call.
- **The web Phone page is the dashboard's SHELL: every other section runs in a frame over it (#142,
  2026-09-23). Never let a dashboard navigation leave `/admin/phone`.** The Twilio Device exists only
  on that page, and a full-page navigation destroys it -- and Twilio never re-offers a call to a
  Device that registered after the call started. So before #142 a call rang NOWHERE while staff were
  on Messages or Voicemail, and clicking back to Phone mid-ring showed it as "In progress" with no
  Answer (reported on the desktop app; the browser was identical). The desktop app loads
  `/admin/phone`, so it got the fix from the web deploy; a desktop-only two-view Electron version was
  written first and dropped because running both designs would register two Devices.
  The load-bearing pieces, all in `src/html/pages/phone.ts`, `layout.ts` and the `/admin/` routes:
  * **Shell or plain page is decided by `Sec-Fetch-Dest`.** `document` (a top-level load) gets the
    Phone page with that section open in `#section-frame`; each `/admin/` route returns it FIRST
    (`topLevel`/`shellHere`), before its own queries, so nothing runs twice and a 404 stays a 404
    (call detail checks the row exists, `deleted_at IS NULL`). `iframe` gets the plain page. A MISSING
    header gets the plain page too -- never the shell, which inside a frame nests a second softphone
    -- and that page sends itself to `/admin/phone?section=...` (layout head script), which is also
    the safety net for a route that forgets `topLevel`. `?section=` accepts only a dashboard path.
  * **`/admin/phone` requested INTO the frame answers a stub** (`renderPhoneFrameStub`) that hands
    `?dial=`/`?listen=` to the running page (`tcbShowPhone` -> `tcbPhoneDeepLink`). Messages "Call",
    Live Calls "Listen" and the staff/demo redirects all land there. The Phone page also guards
    itself: framed anyway, it `window.stop()`s before the SDK loads.
  * **One softphone per browser, via the Web Locks API** (`tcb-softphone`). Every dashboard tab is
    now the Phone page, so without it a Ctrl-clicked second tab rang every call too. A tab whose
    phone failed to start RELEASES the lock (or every other tab waits behind a phone that never
    rings); a lock API that refuses starts the phone anyway.
  * **A ringing call hides the section without unloading it** (`tcbHideSection`, draft kept, media
    paused) and brings it back when the call ends -- unless another call is still up, or the user
    chose Phone ("back to call" button, Phone link, Back), which keeps it loaded but hidden. Hidden
    frames still report `visibilityState` "visible", so the layout wraps `setInterval` in framed
    pages to pause every poll while hidden: Messages' thread poll marks the thread read for the WHOLE
    team, and a hidden one would clear texts nobody saw. It covers `setInterval` only; a new poll
    built on a `setTimeout` chain needs to check `window.tcbSectionHidden()` itself.
  * The frame's location is always REPLACED; the top page gets one `pushState` per section the user
    opens, so Back moves between sections. `beforeunload` asks before leaving mid-call in the
    browser only -- the desktop app has no Back button and must never be kept from quitting.
    `/admin/` pages send `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`, and
    `Vary: Sec-Fetch-Dest` + `no-store`, so Back can never serve the plain page at the top.
  **It took SIX `/code-review` rounds (10, 10, 7, 8, 9, 9 findings) and the count never fell**,
  because each round's fixes were new frame/history/lock code for the next round to find edge cases
  in. It was stopped by agreeing a bar with Phill: fix anything that can drop or miss a call, list
  the rest. Two traps met on the way: a regex with `\/` inside the page's template literal loses
  its backslashes and throws in the browser (write it without a regex), and an iframe keeps its
  intrinsic 150px height under top/bottom insets, so its height is set outright.
  **Still unproven with a real call** as of the merge: ring while on Messages and answer; click Phone
  mid-ring; "Call" from Messages during a call. Every other check was tests plus a real Chrome
  against `wrangler dev`, where the token endpoint 500s (no Twilio creds locally).
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

### Mobile: iOS calling, push and crash reporting

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
- **Known-unresolved:** the mobile in-call screen once showed **no hang-up button** (call answered,
  UI popped). Never reproduced; the paths now log and surface errors instead of silently stranding
  a live call. OTA 70 fixed two things with exactly that shape: the locked-phone launch that stuck on
  the auth spinner, and a lock-screen-answered call that never opened the in-call screen. If it does
  not recur after OTA 70, one of those was it. The iOS **crash loop of 2026-09-07** (app died within a minute of tab mount, over and
  over) was never root-caused either: it was escaped by rolling the OTA back to #49, and #53 carries
  the same code plus crash reporting and has been clean since. If it returns, `/admin/errors` is now
  the first place to look rather than the last.

### Mobile: screens, editors and Android

- **`OTA_BUILD` lives in `mobile/src/lib/build.ts`**, not in the Settings screen — a crash report and
  the Settings screen have to quote the same constant. `publish-ota.yml` greps that file for it, so
  moving it again means moving the grep in the same commit or every publish fails at "Read
  OTA_BUILD".
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

### App Store and Play submission

From `specs/2026-08-28-appstore-listing.md`, `specs/2026-08-28-playstore-listing.md` and
`runbooks/android-play-submit.md` (read those for the listing copy itself). The demo-account
password lives in those two specs -- never copy it anywhere else.
- **iOS:** `ascAppId` is `6806023125` (`mobile/eas.json`); `ITSAppUsesNonExemptEncryption=false` is
  already in `mobile/app.json`. Screenshots are exactly 1320x2868 portrait (the 6.9" set only, 3-10
  of them), taken on the iPhone 16 Pro Max, with no real customer names or numbers; there is no
  iPad set because `supportsTablet` is unset. Unlisted distribution is TWO steps: submit for review
  with a notes line saying it is intended for unlisted distribution, THEN file Apple's unlisted-app
  request -- Apple declines the request for an app not yet submitted or still in beta.
- **Before every submission (both stores):** check `reviewer@...` can still log in via
  `POST /api/login`, and that the privacy/Data-safety answers match what the app collects (see
  Status today -- they are currently out of date).
- **Android, first release:** the first AAB must be uploaded BY HAND in the Play Console -- the Play
  API cannot create an app's first release, so `eas submit` fails "package not found" until then.
  The service-account key is `mobile/credentials/play-service-account.json` (gitignored, path in
  `mobile/eas.json`) and needs the Release manager role.
- **Android, signing:** EAS holds the upload keystore. Enrol in Play App Signing and back the
  keystore up -- without Play App Signing a lost keystore means the listing can never be updated.
- **Android, builds:** only the `production` profile goes to Play (an AAB). `preview` builds an APK
  that must never be uploaded.
- **Android, Console declarations** gate release, both caused by permissions merged in from the
  Twilio SDK's own manifest (not `app.json`): `FOREGROUND_SERVICE_MICROPHONE` needs a demo video
  (place a call, background the app, the call survives, hang up), and `USE_FULL_SCREEN_INTENT`
  needs its own justification. Target audience must be 18+ only -- any under-18 bracket pulls the
  app into the Families programme.
- **Android, launcher icon:** `adaptiveIcon.foregroundImage` must stay
  `android-adaptive-foreground.png` (artwork inside the centre 60%) or it is cropped; regenerate
  with `mobile/scripts/make-play-assets.py`.

### Working practices and testing

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

## Reference (whole-repo audit, 2026-09-27)

Everything below was missing from this file and was checked against the code on `5407a82`. Five
agents compared this file to `src/`, `migrations/`, `mobile/`, `desktop/`, the workflows and
`docs/`; each item was verified in code before it was written here. Refer to code by function
name, not line number.

### Production, secrets and deploy

- **Production is `https://tcbvoip.app`**, a custom-domain route in `wrangler.jsonc`. The desktop app
  loads `https://tcbvoip.app/admin/phone`; the mobile app's API base is `EXPO_PUBLIC_API_BASE_URL`
  in the COMMITTED `mobile/.env` (same value, also the hardcoded fallback in `api.ts`). Pointing a
  build at `wrangler dev` means editing that file — never commit that edit.
- **Worker secrets live in Cloudflare only; `deploy.yml` sets none of them.** Secrets:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (au1); `TWILIO_API_KEY_SID`/`_SECRET` (au1 key: access
  tokens, outbound call creation, cancel); `TWILIO_US1_API_KEY_SID`/`_SECRET` (every SMS send —
  the Messages API is US1-only — message media, and every global host via `globalAuthHeader`);
  `TWILIO_WEBHOOK_SECRET` (+ `TWILIO_WEBHOOK_SECRET_SECONDARY`, `TWILIO_AUTH_TOKEN_SECONDARY` for
  rotations); `TWILIO_PUSH_CREDENTIAL_SID_IOS`; `FB_PAGE_ACCESS_TOKEN`; `SERVICEM8_API_KEY`. Plain
  vars in `wrangler.jsonc`: `TWILIO_FROM_NUMBER`, `TWILIO_SMS_NUMBER`, `TWILIO_TWIML_APP_SID`,
  `TWILIO_PUSH_CREDENTIAL_SID_ANDROID`, `TWILIO_MESSENGER_FROM`, `DEMO_ACCOUNT_EMAILS`. **Without
  the US1 key**, manual send returns 500 "SMS is not configured." and missed-call SMS silently does
  nothing (`globalAuthHeader` falls back to the au1 token, which 401s on US1).
  `TWILIO_INTELLIGENCE_SERVICE_SID` is dead: nothing reads it, and its `Env` field and
  `vitest.config.ts` binding were removed on 2026-09-27. The Cloudflare secret itself may still
  exist; `npx wrangler secret delete TWILIO_INTELLIGENCE_SERVICE_SID` is safe.
- **Webhook auth is the `?whsec=` URL secret first; `X-Twilio-Signature` is only a fallback**
  (`authorizeTwilioWebhook`, `src/twilio/webhookAuth.ts`), because this account's signatures have
  repeatedly failed to match its own token since the rotations. An unset or wrong
  `TWILIO_WEBHOOK_SECRET` therefore rejects, in practice, every Twilio webhook. To rotate it: set
  primary=NEW and secondary=OLD, repoint every Twilio console URL (from `/admin/webhooks`), then
  unset secondary. `/admin/webhooks` is admin-only because it prints the live whsec, the one
  credential on every Twilio webhook.
- **`deploy.yml`, in order (Node 22):** `npm ci`, typecheck, the FULL `npm test`, then
  `wrangler d1 migrations apply tcb-voip-db --remote`, then `wrangler deploy`. Repo secrets:
  `CLOUDFLARE_API_TOKEN` (Workers edit + D1 edit) and `CLOUDFLARE_ACCOUNT_ID` (required, or wrangler
  dies on `/memberships`). Consequences: a flaky test blocks the deploy (re-run it); migrations
  apply BEFORE the new code ships, so the old worker briefly runs on the new schema — **migrations
  must be additive**; a failed deploy step leaves schema ahead of code; and a local
  `npm run deploy` does NOT apply migrations.
- **Bindings.** One Durable Object class, `CallSession` (binding `CALL_SESSION`), SQLite-backed,
  migration tag `v1`: renaming or adding a DO class needs a new `migrations` tag, and renaming or
  deleting `CallSession` destroys in-flight call state. `AUDIO_ASSETS` = R2 bucket
  `tcb-voip-audio`. `EMAIL` = Cloudflare `send_email` binding — **SendGrid is NOT used** despite the
  file name `src/email/sendgrid.ts`; from `noreply@mail.tcbpestcontrolcanberra.com.au`, reply-to
  `office@…`, invite links say 7 days. `AI` = Workers AI. `observability.enabled` is true, so
  Workers Logs keep past logs, not only `wrangler tail`.
- **Two public routes read that R2 bucket, and nothing private may ever go in it.** `/media/<key>`
  serves ANY key with no auth and a one-year immutable cache, because Twilio fetches IVR audio
  mid-call with no credentials (uploads go to `ivr-audio/<uuid>`) — never put it behind
  `requireStaffUser`, and a changed file needs a NEW name. `/desktop/<file>` serves the desktop
  auto-update feed; its strict filename regex is what stops path traversal to anything else — never
  loosen it. `latest.yml` is `no-cache`, installers immutable.
- **Break-glass password:** `node scripts/set-password.mjs <email> <password>` prints SQL to run
  with `npx wrangler d1 execute tcb-voip-db --remote --command ...`. PBKDF2 at 100,000 iterations,
  which is Workers' cap and must match `src/access/password.ts` (production throws above it; local
  tests do not).
- **Test config** (`vitest.config.ts`): binds `AUTH_MODE: "dev"`, `DEV_STAFF_EMAIL`, a fake
  `TWILIO_AUTH_TOKEN` and `TEST_MIGRATIONS` (every file in `migrations/`); excludes `mobile/**`
  (Jest) and `.claude/**` (agent worktrees are whole stale repo copies); 20s timeout.
  `AUTH_MODE=dev` + `DEV_STAFF_EMAIL` belong in `.dev.vars` only.
- **EAS config is `mobile/eas.json` and `mobile/app.json` only.** A stray root `eas.json` and
  `app.json` (`{"expo":{}}`, added by accident in #109) were deleted on 2026-09-27; do not run
  `eas` from the repo root. The "`eas.json` must NOT name `ascApiKeyPath`" rule above means
  `mobile/eas.json`. `.claude/settings.json` also enables `atomic-agents`, which has no committed
  skills copy, so it is absent in cloud sessions. `README.md` was corrected the same day (webhook
  URLs, push SIDs, Node 22, email binding); this file still wins where they differ.

### Scheduled work

- **Two crons, `*/5` and `* * * * *`.** Every tick runs `syncPendingCallsToServiceM8`. The 5-minute
  tick also runs, each in its own `.catch` so one failure cannot stop the rest:
  `reconcileStaleCalls`, `backfillTranscripts` (3 per tick, max 3 attempts), `backfillLabels`
  (2 per tick, `MAX_LABEL_ATTEMPTS` 3), `backfillFacebookNames` (5), `checkMessengerChannelHealth`,
  `resetAvailabilityForNewDay`. An unrecognised cron string runs everything. (The `MINUTE_CRON`
  comment still says "3-minute mark"; the delay is 15 minutes.)
- **Away/offline is a ONE-DAY override.** `staff_users.status_set_on` (migration `0028`) holds the
  Canberra date it was set, and `resetAvailabilityForNewDay` puts anyone set on an earlier day back
  to `available` (`AVAILABILITY_RESET`). So "Away is STICKY" above is true only within one day. The
  admin status PUT stamps the date too.
- **`reconcileStaleCalls`:** any `in_progress` row older than 2 minutes that Twilio (au1) no longer
  lists as in progress gets Twilio's terminal status and `end_time`; a Twilio 404 counts as
  completed; the sweep aborts if the bulk lookup fails. It writes `ended_at` (so ServiceM8 then
  picks the call up) but writes no `call_ended` event and sends no missed-call SMS. Live Calls hides
  `in_progress` rows older than 3 hours.
- **ServiceM8 with no key loses calls for good.** With `SERVICEM8_API_KEY` unset, calls are never
  claimed and age out of the 2-hour window; setting the key later backfills nothing older.
  Soft-deleted calls are skipped. 5 calls per tick.
- **Nothing is ever purged.** No retention job: `client_errors`, `call_events`, `login_attempts`
  (except on a successful login), soft-deleted calls/messages and `fb_name_attempts` grow forever.
  The only automatic cleanup is expired `sessions`, deleted opportunistically at login.

### Call transcripts today

- **Labelling runs entirely in the worker; Twilio Conversational Intelligence is gone** (it is
  unsupported in AU1, error 95122, and its only alternative is a public `media_url`). The worker
  fetches `<recording>.wav?RequestedChannels=2` with the au1 token, splits the 16-bit PCM stereo
  itself (`src/audio/wav.ts`), runs Whisper once per channel sequentially, and merges with
  `buildLabelledTurns` (`src/labelledTranscript.ts`). Migration
  `0041_reset_legacy_transcript_status.sql` reset every old Intelligence status to NULL.
- **`intelligence_status` now means:** `completed` (labelled); `label_retry` (media host 5xx/429 or
  the fetch threw — retried by `backfillLabels`, attempts counted in `intelligence_polls` before the
  work); `unlabelled` (terminal: would not split, or last retry failed); `dual_failed` (two
  channels asked for, one came back — Health Checks FAILS on this even when other calls worked);
  `single_channel` (legacy mono conference recording, warn only). Deliberately unmarked, log line
  only: a 4xx on the two-channel file, a recording over `MAX_SPLIT_BYTES` (25 MB, about 13 minutes,
  checked before buffering to protect the 128 MB isolate), and a call where nobody spoke.
  `transcribeCallRecording` still guards its write on `intelligence_status <> 'completed'`.

### Call routing reference

- **IVR node types.** Pass-through (walked without stopping): `business_hours`
  (open/closedNextNodeId), `date_rule` (closed dates: `YYYY-MM-DD`, ranges, recurring `MM-DD`,
  recurring ranges), `play`. Stopping: `gather`, `input`, `ring`, `wait`, `voicemail`, `callback`,
  `redirect`. `gather` is always ONE digit, default timeout 8s, `retryLimit` default 0, then
  `defaultNextNodeId` (a missing default throws, and the catch-all hangs up). `input` defaults to
  12 digits, `finishOnKey` `#`, logged as `input_received`. `redirect` renders a bare
  `<Dial>number</Dial>` — no recording, timeout or ring tracking. A cycle within one walk throws.
  Gather continuations look the node up by id with no flow predicate.
- **Ring config** is `{target: 'all'|'on_call'|emails[], strategy: 'cascade'|'simultaneous',
  timeoutSeconds, noAnswerNextNodeId}`. Simultaneous dials everyone; first answer cancels the rest;
  exhausted when `attemptSids` empties. Cascade dials in `ring_priority` then email order, one leg
  at a time, advancing on each failure. A leg with no timeout falls back to 20s. Zero targets skips
  ringing and walks `noAnswerNextNodeId` (after the greeting).
- **The softphone heartbeat does NOT gate ringing.** `isStaffAvailable` is just `isOnShift` (status
  `available` + own schedule), because the heartbeat only ticks in the foreground and VoIP push
  reaches a closed app. `HEARTBEAT_STALE_MS` (5 min) is display-only; the app never writes presence
  on launch or unmount. (The `ringQueue.ts` comment saying "a fresh heartbeat proves the app is
  online" is stale.)
- **Greeting-first deferred dial.** When PLAY steps precede a direct ring, staff are not dialled
  until the first hold poll (`pendingDial`), so nobody answers mid-greeting — and `ring_started` is
  logged only then, so a caller who hangs up during the greeting has none (this is what the
  missed-SMS "reached a ring" rule relies on). The zero-target path splices the greeting in with a
  FUNCTION replacer, because admin text containing `$&` would corrupt the TwiML.
- **Hold (`wait`) step, after #144/#146.** `callbackKey` is per step (default `*`, from
  `CALLBACK_KEYS`, never `#` — the Gather finish key), validated on write and at ring time. The
  announcement plays until heard to the end once (`holdAnnounce`, reset each ring round); a wrong
  key replays it at most `MAX_ANNOUNCE_REPLAYS` = 2 times, then ringback continues inside
  `<Gather finishOnKey="">`. Plain ringback with no callback option has no `<Gather>`: the document
  is exactly one 3.0s ring cycle. `callbackNextNodeId` supplies only the WORDS of a `callback` step
  in the same flow — it is never walked, deliberately not validated against its target, and falls
  back to built-in wording. Mobile keeps its own `CALLBACK_KEYS` copy that must match
  `src/ivr/flowEngine.ts`.
- **A callback request now records a message** (#140). Both routes into one (a `callback` node and
  the hold key) go through `recordCallbackRequest`: it creates the `callback_requests` row and the
  push immediately, speaks the ack (default "Thanks, we'll call you back soon."), then ALWAYS
  "Please leave a message after the beep." and `<Record maxLength=120 timeout=5>`. The recording
  lands with `mailbox_label = 'Callback request'` (so it shows in voicemail lists) and
  `notifyVoicemail` is skipped so the call is not pushed twice. The `awaitingCallbackRecording` DO
  flag tells it apart from a voicemail.
- **The async-AMD rescue had never actually run before the `ivr_path` fix.** `handleAmdFallthrough`
  always found `activeRing` already deleted (queue_left removes it at the bridge; AMD lands 2-4s
  later), so callers were hung up instead of reaching business voicemail — zero
  `no_answer{mobile_voicemail_answered}` rows existed. It now recovers `noAnswerNextNodeId` by
  joining `calls.ivr_path` to a `type='ring'` node, and `handleQueueLeft` writes `ivr_path` BEFORE
  deleting `activeRing`. That order is load-bearing.
- **Late answers.** A turned-away leg hears "This call was answered by someone else." A redelivered
  answer for the bridged leg (`bridgedAgentSid`) gets the join document again without
  re-redirecting the caller. The `queue_left` bridged branch also renders the recording join
  (`conference=1&rec=dual&staffch=2`), accepting a possible duplicate recording over none.
- **`call_events` types** written by CallSession: `call_started`, `menu_selection`,
  `input_received`, `redirected`, `ring_started{targets,strategy}`, `answered{agentCallSid}`,
  `mobile_machine_answered`, `no_answer` (optionally `{reason:'mobile_voicemail_answered'}`),
  `caller_hung_up`, `callback_requested`, `voicemail_left{mailboxLabel}`; the worker writes
  `call_ended{status}`. The missed-call PUSH is once per call (`missedNotified` DO flag, set before
  sending) across all ring rounds.
- **Logs to grep first.** `CALLSESSION_ERROR {kind}` is the catch-all ("technical issue") — grep it
  first when a caller reports that. `ENTRY_FLOW_FALLBACK {failed, next, error}` marks each failed
  rung of the per-number fallback chain.
- **`CallerName` must ride on EVERY `client:` leg** (#126/#127). Each leg carries `CallerNumber`
  (bare digits, no `+`) and `CallerName` (saved contact, else the number), built by
  `clientDialTarget` and percent-encoded with `encodeURIComponent`, NEVER `URLSearchParams` (the
  lock screen would read "Jane+Customer"). The iOS/Android native banner uses the template
  `${CallerName}`, set natively via `setIncomingCallContactHandleTemplate` and cached before any JS
  runs, so a leg without it shows the literal `${CallerName}`. Never fall back to the business
  number (the #116 regression). Deploy the worker BEFORE any OTA that reads a new key.
- **The ringback is self-hosted and versioned by filename.**
  `https://tcbvoip.app/media/system/ringback-au.wav` is a synthesised Australian 400/425/450 Hz
  double ring, exactly one 3.0s cycle, and that length is load-bearing for both the queue hold and
  the conference `waitUrl`. Twilio's `sdk.twilio.com` copy 403s to Twilio's own media servers
  (error 11200, "application error") — never revert to it. `/media/` is immutable-cached, so a new
  tone needs a NEW filename.
- **On-call edge cases.** Weeks before the anchor use a floored modulo, so a future anchor still
  resolves. An unrecognised weekday token THROWS rather than defaulting to Monday; callers treat
  that as "nobody on call".
- **The call blocklist is normalised to E.164 on the server, by one rule** (#136,
  `src/api/blocklistNumber.ts`). The only consumer is a LITERAL `blocklist.includes(params.From)`
  in `worker.ts` before the DO, so any non-E.164 entry would block nobody. Typed AU formats are
  accepted, the number must be COMPLETE (1300 carved out of 13xxxx), letters are rejected, and a
  bad entry gets a JSON 400 naming it.
- **Recovering an unlinked recording:** `POST /api/calls/:id/recover-recording` (admin-only; "Check
  Twilio for it" on the call detail page) asks au1 `Recordings.json?CallSid=` and takes the
  LONGEST recording (a false start is always shorter), backfilling `recording_url`/`sid`/`duration`.

### Messaging, push and Facebook

- **Message attachments** (migration `0042`, #137). Inbound `NumMedia`/`MediaUrlN` is stored in
  `message_media(message_id, idx, content_type, url)` — Twilio's URL only, never the bytes, max 10,
  `OR IGNORE`, in its own try (`MESSAGE_MEDIA_INSERT_FAILED`) so it never fails the SMS webhook.
  Staff fetch through `GET /api/messages/:id/media/:idx`, which uses `globalAuthHeader` (US1), only
  fetches `https://*.twilio.com` URLs (our credentials never go to a URL taken from a webhook),
  ALLOWLISTS the content type (jpeg/png/gif/webp/pdf inline; everything else becomes an
  `application/octet-stream` attachment; SVG deliberately excluded — it would be stored XSS on our
  own origin), and sends `nosniff` + `Cache-Control: private`. A Twilio 404 means the media aged
  out and stays 404 forever; anything else is 502. The Twilio URL never reaches a client; mobile
  fetches with the session token as a header, never in the URL, and its `INLINE_IMAGE_TYPES` must
  mirror the proxy's allowlist. Previews say "Photo" when the body is empty. **MMS never reaches the
  AU numbers** (Twilio MMS is US/Canada only), so in practice this carries Messenger attachments.
- **D1 caps a query at 100 bound parameters, and miniflare does not enforce it.** A
  `WHERE x IN (?,?,…)` over an unbounded list passes every test and 500s in production; the thread
  view hit exactly this, which is why `listMediaForPeer` selects by peer with one parameter.
- **Messenger runs through Twilio; there is no Meta webhook.** It arrives on the Twilio SMS webhook
  as `From=messenger:<psid>` and is sent from `TWILIO_MESSENGER_FROM` (`messenger:<page id>`). Names
  come via `FB_PAGE_ACCESS_TOKEN`: the per-psid profile lookup returns code 100 for ordinary
  customers (`pages_messaging` is only at Standard Access), so the route that works is the Page's
  own inbox, `GET /<page-id>/conversations?fields=participants` (at most 5 pages), which the
  webhook and the cron try first. `MAX_NAME_ATTEMPTS` 12, `RETRY_AFTER_MS` 30 min;
  `isTokenLevelFailure` records `last_error` without spending an attempt, and so does
  `noteTwilioMessengerFields` (diagnostics only). A hand-typed name is overwritten by a later
  successful lookup.
- **Messenger channel alert:** 3+ failed/undelivered outbound Messenger messages in 15 minutes sends
  one "Facebook Messenger may be down" push to `notif_sms` holders, 6-hour cooldown stamped only if
  a device was actually sent to (`FB_CHANNEL_ALERT_NO_DEVICES`/`_UNDELIVERED` otherwise). It reacts
  only to real traffic, so a break during a quiet spell goes unnoticed.
- **Push types:** `sms`, `missed_call`, `incoming_call`, `message_failed`, `voicemail`,
  `callback_request`, `channel_health`, `test`, gated by per-user `notif_incoming|missed|voicemail|
  sms|callback` (all default on; `message_failed` and `channel_health` ride on `notif_sms`). Every
  push goes to every live token — the whole team — via Expo with `channelId: "messages"`. Only
  `DeviceNotRegistered` tokens are pruned; other ticket errors log `EXPO_PUSH_TICKET_ERROR`. Under
  `AUTH_MODE=dev` pushes are skipped. `upsertPushToken` COALESCEs `ota_build`/`native_build` but
  OVERWRITES `session_hash`.
- **Message timestamps are two mirrored copies** (#139): `msgTime(ts, nowMs)` in the web client JS
  and `messageTimeLabel(ts, now)` on mobile — today = time, then "Yesterday", then day and month,
  then the year when it differs. `now` is a parameter so the rule is testable. Change both, like
  `msgStatusLabel`.
- **`normalizePhone` exists in THREE copies that must match exactly:** `mobile/src/lib/phone.ts`,
  `src/db/contacts.ts` and the web `src/html/pages/phone.ts`; contacts match on the stored
  `phone_normalized`. Mobile Recents search (#131) runs on-device over up to 2000 loaded calls
  (Recents is capped at 2000 rows by `listCalls`), matches name plus the other party's number by
  direction, tries both raw and normalised digits, and ignores a single digit.

### Auth, demo account and web pages

- **Staff sessions effectively never expire.** `SESSION_TTL_MS` is 10 years on purpose: timed
  logouts meant missed calls. A session ends only on logout, password reset or staff removal
  (`destroySessionsForEmail`). Web uses the `tcb_session` cookie, mobile `Authorization: Bearer`,
  resolved cookie-first in `requireStaffUser`; a valid session whose email is not in `staff_users`
  gets 403 "not provisioned".
- **Every new `/api/` route must be checked against `handleDemoRequest`** (`src/demo/index.ts`);
  only `$`-anchored paths are substituted, so a route ending in its own suffix falls through to the
  real handler. Four did until 2026-09-27 (`PUT /api/facebook/name`, which renamed a real Messenger
  sender; `POST /api/facebook/resolve-names`; and the two `/restore` undo routes); all are swallowed
  now and pinned in `test/demo/demoAccount.test.ts`. The media route was closed only after review
  found it streaming real photos.
- **Inline page scripts inside TS template literals: no backticks and no `${…}`** — use `+`
  concatenation (`ivrFlow.ts`, `layout.ts`'s `NOTIFY_JS`). Same trap family as the `\/` regex in
  `phone.ts`. Desktop/web OS notifications for SMS fire only from the top page
  (`window.top === window`); call notifications come from the Device event in `phone.ts`, not
  polling, because polling lagged up to 6s.

### Mobile release

- **The build number in `mobile/app.json` is the LAST ONE SHIPPED, and must be committed after
  every build.** The production profile has `appVersionSource: "local"` and `autoIncrement: true`,
  so EAS increments the file's value on the builder and uses that — but the bump lives only on the
  builder unless someone commits it. It was left at `"4"` after build 5 shipped, so the next build
  would have been 5 again, which Apple rejects permanently. Set to `"5"` on 2026-09-27 (checked
  against the EAS build list: build 5, 2026-09-10, is the last iOS build that finished), so the next
  build is 6. `android.versionCode` stays 1: EAS has never run a production Android build (every
  Android build is a `preview` APK), so no code has been used on Play through EAS. **After any
  production build, commit the new number.**
- **Every binary ever built shares runtime `1.0.0`** (`runtimeVersion` policy `appVersion`,
  `version` 1.0.0), so every binary receives every OTA. An OTA that imports a native module an
  older binary lacks crashes that binary on launch; the guard is bumping `expo.version`, which
  starts a new runtime. The Settings "Version" row reads `NATIVE_VERSION`
  (`expo-application`'s `nativeApplicationVersion`, in `src/lib/build.ts`) since OTA 82; it was
  hardcoded `"1.0.0"` before and would not have followed a bump.
- **Two OTA publish paths, and they differ.** GitHub `publish-ota.yml`: inputs channel
  (`preview`/`production`/`both`, default `preview`) and message; needs repo secret `EXPO_TOKEN`
  (Expo account `skiptoolow`); runs mobile typecheck and tests first; prefixes `#<OTA_BUILD>`;
  publishes `--platform all`; warns (does not block) on production during App Store review. EAS
  `mobile/.eas/workflows/publish-update.yml`: defaults to `production` and adds no OTA number. It
  published with NO typecheck or tests until 2026-09-27; it now has a `checks` job (checkout,
  install, `npm run typecheck`, `npm test -- --ci`) that `publish_update` `needs`, validated with
  EAS's workflow validator. Prefer the GitHub one anyway, for the OTA number in the message.
- **Channels:** `preview` = Android test handsets; `production` = iOS TestFlight/store AND
  Play-internal Android (built with the production profile). `development` and `test` have their
  own channels.
- **The `test` EAS profile is a separate app.** `APP_VARIANT=test` makes `app.config.js` name it
  "TCB Phone (Test)" with bundle ID/package `au.com.tcbpestcontrolcanberra.tcbphone.test`, so it
  installs beside the real app — but that package is not in `google-services.json` and the au1 APNs
  VoIP credential is for the production bundle ID, so a test build will NOT receive incoming-call
  pushes (its Android build may also fail at the google-services step; unverified).
- **Push registration is keyed on the session token.** A second staff member signing in on the same
  handset must re-register, or the Expo token stays bound to the previous user (who keeps getting
  customer texts on a phone they no longer hold). A 401 from ANY endpoint is a global sign-out in
  `apiFetch`; `logout()` wraps itself in a 5s `AbortController` because `apiFetch` has no timeout.
- **Per-handset preferences** — Auto-Answer, Call Waiting, Bluetooth, Audio Routing — live in
  SecureStore (`pref_*`, `src/lib/prefs.ts`), not the server: an admin cannot see them and they do
  not follow the user to another phone. Incoming invites go through `decideInviteAction`.
- **Root layout module-scope work:** `wireQueryFocusToAppState()` (React Query's refetch-on-focus
  never fires on React Native; this makes "app became active" the focus signal and pauses every
  `refetchInterval` in the background), the crash reporter, and `primePushRegistry()`. The Twilio SDK
  import there is safe only because the SDK is compiled into every build — if it ever becomes
  optional, make it a lazy require or a missing SDK is a launch crash with no UI.
- **Tooling traps:** the stock Expo `reset-project` script (it moves `src/` and `scripts/` to
  `example/`, wiping the app) was deleted from `mobile/` on 2026-09-27 — do not restore it. The Twilio SDK is a PREVIEW release,
  `@twilio/voice-react-native-sdk@2.0.0-preview.2`, under a caret range — the lockfile is what pins
  it. `mobile/.npmrc` sets `legacy-peer-deps=true`, and `npm ci` depends on it. Settings >
  "Preview Incoming Call" shows the ringing UI with a dummy number, no real call.
- **Admin dead ends fixed in #136:** `loadFlowOrEmpty` treats a 404 as an empty new menu (a named
  flow has no rows until its first step is saved) and rethrows anything else; the blocklist's
  `withPendingEntry` counts a typed-but-unadded entry in Save and `dirty` — the same
  `keyboardShouldPersistTaps` trap as `TimeField`/`NumberField`.

### Desktop release

- Feature changes ship with the worker deploy; a desktop release is only for the Electron shell.
  `cd desktop && npm run build` (electron-builder, Windows x64 NSIS, UNSIGNED — SmartScreen warns).
  Bump `version` in `desktop/package.json` first (1.2.2 as of 2026-09-27) and add a
  `releaseNotes.js` entry, or nothing shows after the update. `npm run release:upload` puts the exe,
  blockmap and `latest.yml` into R2 `tcb-voip-audio` under `desktop/`, manifest LAST, and refuses a
  stale `release/latest.yml`. `electron-updater` polls `https://tcbvoip.app/desktop/latest.yml` on
  launch and every 6 hours.

### Hazards found by the audit, and what was done (2026-09-27)

All fixed in the same PR as this section, each with a test that fails against the old code where a
test is possible:
- **Manual Facebook name refresh** (`handleResolveFacebookNames`) used only the per-psid lookup,
  which returns code 100 for ordinary customers. It now asks the Page inbox first, like the webhook
  and the cron, and falls back per-psid only for whoever the inbox does not list.
- **`deletePushTokens`** built one unbounded `IN (?,…)` list, which would 500 in production past
  100 tokens. It now deletes in chunks of `DELETE_CHUNK` (90) in one `db.batch`. Its test wraps D1
  in a proxy that throws on more than 100 bound values, because miniflare does not.
- **`resolveRingTargets`'s `excludeEmails` is REQUIRED now**, not defaulted to `[]`.
- **Four demo-account write routes are swallowed now:** `PUT /api/facebook/name`,
  `POST /api/facebook/resolve-names`, `POST /api/calls/:id/restore`,
  `POST /api/messages/:peer/restore`.
- **Stale comments rewritten:** `missedCallSms.ts` (two senders), `worker.ts` (the status-webhook
  send and `MINUTE_CRON`'s 15 minutes), `ringQueue.ts` (heartbeat, and the `CallSession.ts:402`
  reference), `publish-update.yml` (`OTA_BUILD` path).
- **Also:** iOS `buildNumber` set to 5, EAS publish checks added, dead
  `TWILIO_INTELLIGENCE_SERVICE_SID` removed, stray root EAS files and `reset-project` deleted,
  README corrected, tenancy spec and plan corrected, Settings "Version" reads the real version.
  `OTA_BUILD` 81 -> **82** for that last change; **82 was published** 2026-09-27 05:43 UTC
  (Publish OTA run #43, green), and the worker deployed from the same commit (Deploy #171).

Still open, deliberately:
- The `test` EAS profile cannot receive incoming-call pushes (its package is not in
  `google-services.json` and the VoIP credential is for the production bundle ID). Fixing it needs
  a Firebase app and an Apple VoIP certificate for the `.test` IDs — console work, not code.
- No retention job exists (see Scheduled work). Deciding what to delete, and after how long, is
  Phill's call.

## Repair log

Every fix shipped, newest last. Add a line here with each merged PR.

### Dated summaries

Written at the time; kept as they were.

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
  falling over must be able to say so whoever holds it). Handsets were on **OTA 78** (published
  2026-09-22 07:30, both channels); master has since bumped `OTA_BUILD` to 79 (#136), 80 (#137)
  and **81** (#146) — whether each was PUBLISHED is not recorded here, so check the Publish OTA run
  history before assuming. And the first binary carrying the native CallKit fix is
  **build 5** (2026-09-10), **confirmed installed on Phill's iPhone on 2026-09-11**. Settings shows
  that as `#<OTA> · b5` (it read `#78 · b5` on 2026-09-22) — and the `· b5` half only renders from OTA 67 onwards (see the bullet on it
  below). **Build 5 expires around 2026-12-09**: internal TestFlight builds last 90 days, so the
  binary needs re-uploading quarterly even when no native code has changed.
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
    `<Dial>`. See the bullet on it below. **Settled 2026-09-22**: Twilio's Conversational
    Intelligence turned out to be unusable here at all (unsupported in AU1) and was deleted; the
    labelling is done in the worker now, and the first real labelled transcript came out correct.
    Only **call-via-mobile** — the one flow with the channels reversed — is still unread.
  * **A Twilio Auth Token was exposed in chat on 2026-09-10 and needs rotating** if it has not been.
    The ORDER matters: create a SECONDARY token in Twilio, update `TWILIO_AUTH_TOKEN` in the
    Cloudflare dashboard (Workers & Pages > tcb-voip > Settings > Variables and Secrets), make one
    test call in and out, and only then promote it. Killing the old token before the worker holds
    the new one breaks live calls — not because of webhook auth (webhooks authenticate by the
    `?whsec=` URL secret first; see the webhook-auth bullet in the reference section) but because
    the answer-time `redirectCall`, `hangupCall` and every conference operation authenticate with
    `TWILIO_AUTH_TOKEN`. (Corrected 2026-09-27; this line used to blame webhook signatures.)
    `TWILIO_AUTH_TOKEN_SECONDARY` lets both tokens pass signature checks during the swap.
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

### Before pull requests (2026-08-07 to 2026-09-01, pushed straight to `master`)

- **08-07 to 08-10** -- the foundation: D1 schema, business hours, Twilio signature checks, the IVR
  state machine in the `CallSession` Durable Object, call lifecycle tracking, staff table, settings
  and call APIs, the first web pages (Call History, Settings, Live Calls), the Electron desktop
  wrapper, and the IVR flow editor with its first review fixes (uploaded audio playback, node ids).
- **08-12** -- softphone hold put the OTHER party on hold, `device.connect()` awaited (SDK 2.x),
  outbound calls given a `calls` row, conference-membership checks on hold/transfer.
- **08-15 to 08-16** -- email/password auth replaced Cloudflare Access: PBKDF2 (100,000 iterations,
  the Workers cap), D1 sessions, login rate limit, invite/reset tokens, break-glass script, staff
  admin; then the Expo app scaffold, login, Live Calls and EAS config.
- **08-19 to 08-23** -- inline recording playback, mobile call history/detail/callbacks, tabs,
  branding, softphone surface, messaging, Android launch-crash fixes (`@expo/ui` removed, PNGs
  re-encoded), staff invites moved from SendGrid to Cloudflare `send_email`, admin-only web pages,
  native outbound and incoming calls, the dialled leg cancelled when the agent hangs up first, the
  **au1 push credential fix (error 52161)**, ringback instead of hold music, IVR editor usability,
  SMS send/receive on `+61485034869`.
- **08-25** -- calling/SMS hardening, Whisper transcription, number picker, live listen-in.
- **08-27 to 08-28** -- iOS PushKit registry initialised before registering; move to `tcbvoip.app`
  plus legal pages; per-user settings and notification toggles; ring-my-mobile (pstn legs, AMD);
  business-wide recording setting; missed-call and voicemail pushes; audio routing, auto-answer and
  call waiting; Facebook Messenger replies via Twilio; Play Store release config; transcription
  backfill cron; call outcome and notes on mobile.
- **08-29 to 09-01** -- Messenger names (Page inbox, hand-naming), desktop load retry and
  Cloudflare-hosted auto-update, staff no longer timed out.

### Pull requests, oldest first (every merged PR on `master`)

**2026-09-02**
- #17 Fix mobile reconnect flapping and silent Facebook send failures
- #18 chore(mobile): bump OTA_BUILD to 30
- #19 feat(servicem8): auto-log completed calls as a job diary note
- #20 fix(servicem8): skip Unsuccessful jobs when picking the job to note
- #21 docs: mark the tenancy foundation plan as shelved
- #22 feat(servicem8): auto-fill contact names from ServiceM8 job contacts
- #23 fix(mobile): show "Not delivered" on failed outbound messages
- #24 feat(messaging): capture delivery error codes, alert on failure, and watch channel health
- #25 fix(webhooks): add the missing sms-status URL to the admin webhooks page
- #26 fix(calls): divert to mobile when ring-my-mobile is on, and fix the recording player

**2026-09-03**
- #27 fix(calls): run voicemail detection async so the caller stops ringing on answer
- #28 feat(mobile): pick the sending number from a dropdown showing name and number
- #29 docs: bring CLAUDE.md's current status up to date
- #30 chore(mobile): clear the two eslint warnings
- #31 feat(web): compose new messages and save contacts in the page, not in browser dialogs
- #32 chore(mobile): track the eslint config so lint works outside this machine
- #33 feat(mobile): save a contact from a message thread
- #34 fix(mobile): show the message you are typing on Android
- #35 Number regions, contact search in the composer, and a tappable name in mobile threads
- #36 docs: the landline port is done, and voice numbers must be au1
- #37 docs: unlisted distribution is the iOS plan, not a public listing
- #38 Serve the App Review demo account invented data
- #39 fix: the demo account must never be rung or transferred to
- #40 feat: a public /support page for the store listings
- #41 fix: ring staff who are on shift, not just staff with the app open
- #42 feat: staff set their own availability, and it resets each morning

**2026-09-04**
- #43 feat(mobile): search contacts by name in the New Message To field
- #44 chore(mobile): drop the unused wrangler devDependency
- #45 fix: release queued callers to the menu instead of ringing forever
- #46 feat(ivr): add a callback node so a menu key can request a callback
- #47 fix(audio): use an Australian ringback tone, and stop the Gather distorting it
- #48 feat(mobile): add a connection test so call quality is measurable, not guessed
- #49 fix(mobile): stop the app aborting when a caller hangs up while it is ringing
- #50 fix(mobile): dismiss the ringing screen when the call is answered natively
- #51 fix(mobile): show the live call instead of a black screen after answering

**2026-09-06**
- #52 A callbacks section in the mobile app, and a way to clear one

**2026-09-07**
- #53 feat(mobile): add an admin-only Admin section
- #54 fix(servicem8): actually name callers who are already in ServiceM8
- #55 feat(servicem8): look the caller up 3 minutes after the call, not instantly
- #56 feat(admin): health checks and end-to-end tests on the phone
- #57 fix(test): drop the `global` reference that broke the deploy typecheck
- #58 feat(calls): "Call via my mobile", and name the caller on the call screens
- #59 fix: complete the call-via-mobile wiring, and add recoverable deletes

**2026-09-08**
- #60 fix: stop call-via-mobile erroring, and add a Voicemail section
- #61 fix: show voicemails that have no transcript, and start reporting crashes
- #62 refactor(web): make the Voicemail page look like the rest of the dashboard

**2026-09-09**
- #63 fix(dial): stop phones ringing after a call is answered — and drop Call History from the web
- #64 docs: bring CLAUDE.md current, and correct the demo-account note
- #65 fix: mark missed calls properly, make them read red, and stop sending two notifications for one
- #66 feat: speaker-labelled call transcripts, Add Contact from Call Details, and the business caller ID on staff legs
- #67 feat(dial): ring a staff mobile from the customer's number
- #68 docs: the whisper flag is whisper=1, not pstn=1
- #69 fix(messages): stamp a thread delete once, or Undo silently fails
- #70 fix(messages): stop a hidden thread being mutated behind its own undo
- #71 fix(dial): a caller-ID lookup must never hang up a live call

**2026-09-10**
- #72 fix: eight silent failures found by the whole-repo review (tier 2)
- #73 fix: eight more silent failures, and two ring-path hangups (tier 3)
- #74 fix(mobile): one tap = one call, and make crash reporting actually work
- #75 fix(mobile): create the PushKit registry at launch, or iOS kills the app mid-ring
- #77 fix(ios): align buildNumber with the build that actually shipped
- #76 docs: record the 0xBAADCA11 root cause before it is lost
- #78 fix(mobile): build the Twilio voice module during native launch
- #79 fix(ios): put the extraModules override in the delegate's class body
- #80 fix(ios): stop naming RCTBridgeModule, which Swift cannot see from the app target
- #81 fix(ios): add extraModulesForBridge: with the ObjC runtime, not a Swift declaration
- #82 docs: build 5 compiled, so record which Swift shape works
- #83 feat(ci): submit iOS to TestFlight from the Actions tab
- #84 feat(eas): submit iOS to TestFlight as an EAS workflow, replacing the GitHub one
- #85 fix(eas): drop the build_id input, which fails validation when blank
- #86 fix(eas): find the build with get-build, since submit requires a build_id
- #87 fix(eas): authenticate the submit with EAS-held credentials, not a gitignored file
- #88 docs: record what actually made the TestFlight submit work
- #89 feat(dial): an after-hours on-call rotation, so a night call rings somebody

**2026-09-11**
- #90 fix(mobile): give the Admin hub a way out, and the on-call icons a fallback
- #91 feat(mobile): the phone menu, as a list of steps
- #92 fix(on-call): act on the code review of the rotation
- #93 chore(mobile): bump OTA_BUILD for the on-call review fixes
- #94 fix(on-call): two further review rounds over the rotation
- #95 docs: record the day, and the lesson the day was actually about
- #96 fix: business hours won't save on mobile, and a mono recording invisible to Health Checks
- #97 fix: the phone-menu review findings, and why the softphone never rang
- #98 fix: a logged-out handset that kept ringing, and making the APNs credential readable

**2026-09-12**
- #99 fix: ServiceM8 waits 15 minutes, and a push-credential 404 stops crying wolf
- #100 fix(push): a VoIP push credential must live in au1, and the Console cannot make one
- #101 fix(transcripts): record dual-channel on the Dial, because the Console switch does not work

**2026-09-13**
- #105 fix: five worker bugs from the repo scan (voicemail hangup, re-ring, Away reset, demo leaks)
- #106 fix: every remaining bug from the repo scan (44 fixes, worker + OTA 70)
- #107 docs(claude): record the 2026-09-13 repo bug scan and the rules it left behind

**2026-09-15**
- #108 fix ring-timeout voicemail bug + add auto missed-call SMS
- #109 feat(mobile): add Missed-Call SMS to Admin

**2026-09-16**
- #110 fix: missed-call SMS never fired for a voicemail or a callback request
- #111 fix(mobile): incoming calls showed the business number, never the caller's
- #112 fix: 1300/1800/13xx numbers could not be dialled from the softphone
- #113 fix: don't crash /twiml/voice-app on a Twilio create-call rejection
- #114 docs: wire the after-hours IVR branch to the on-call rotation

**2026-09-17**
- #115 fix(transcripts): intelligence.twilio.com is a global host, not au1
- #116 fix(mobile): native call notification showed the business number, not the customer's
- #117 fix(transcripts): persist Twilio's actual create-failure so Health Checks can quote it
- #118 fix: mobile audit 2026-09-17 (15 bugs, worker + OTA 74)
- #119 fix(mobile): catch the late hang-up of a call ended before it attached (OTA 75)

**2026-09-18**
- #120 fix(desktop): one incoming-call toast, a lock that holds, and a publish guard
- #122 feat(desktop): say what changed after an update installs
- #121 fix(transcripts): stop sending participant overrides Twilio refuses
- #123 fix(calls): refuse an inbound call to a number whose voice is switched off
- #124 chore(calls): record the custom parameters Twilio posts on the agent-answer leg
- #125 chore(calls): record the caller number attached to each softphone leg
- #126 fix(calls): stop advertising the business number as the incoming caller
- #127 feat(calls): show the saved contact's name on an incoming call, else the number
- #128 feat(transcripts): label who said what on outbound calls too

**2026-09-21**
- #129 docs(mobile): the Expo SDK 54 pin rests on the native CallKit fix, not Expo Go
- #130 feat(transcripts): label the speakers ourselves, because AU1 cannot use Twilio's
- #131 feat(mobile): search Recents by name or number

**2026-09-22**
- #132 feat(ivr): give every phone number its own call route
- #134 docs: the speaker labels are confirmed against a real transcript
- #133 Fix the OTA number collision, and record the traps that caused it
- #135 docs: refresh the status lines that had gone stale
- #136 fix(mobile,web): admin screen dead ends, and one blocklist rule on the server
- #137 feat(messages): receive and show picture messages
- #138 fix(sms): send the missed-call text when the call ends, not mid-IVR

**2026-09-23**
- #139 feat(messages): show when each message was sent or received
- #140 fix(calls): tell a callback caller to leave a message before the beep
- #141 Correct the memory that had drifted from the code
- #142 fix(web): calls ring on every dashboard section, not only Phone

**2026-09-24**
- #143 docs: record the Phone-page shell in CLAUDE.md
- #144 fix(calls): keep the phones ringing while callers hear the hold message
- #145 Commit Superpowers and caveman skills so every session loads them
- #146 fix(ivr): hold step's callback key plays an editable callback step; callback list shows contact names

**2026-09-27**
- #148 Missed-call SMS: at most one text per caller per Sydney day
- #147 docs: record 10s ring-step chain fix for calls reaching carrier voicemail
- #149 docs(CLAUDE.md): record advanced-security false failure, D1 query gotchas, desktop process count, untested ring chain
- #150 docs(CLAUDE.md): whole-repo audit — fix stale claims, add missing reference
- #151 fix: close the audit's hazards, and record them in CLAUDE.md
- #152 docs(CLAUDE.md): ring chain proven by a real call; OTA 82 published

**2026-09-28**
- #153 fix(web): show the call screen as soon as an outbound call is placed
- (#155) fix(web): the softphone's "Session expired" was a network blip that never cleared
- fix(calls): outbound softphone calls ring until answered instead of one ring then silence
- (#154) fix: quitting the desktop app no longer sets the account Offline (server guard + desktop 1.2.3)
- (#154) docs(CLAUDE.md): one memory file -- rules checklist, status today, notes by topic, repair log

PR numbers 1-16 predate this log (work went straight to `master`); 76 and 121 merged out of
numeric order; 102-104 were never merged.

## History: superseded notes

Kept for the record only -- none of this describes the system today. Twilio Conversational
Intelligence was removed on 2026-09-27; see "Call transcripts today" under Reference.

- **[SUPERSEDED 2026-09-27 — Twilio Conversational Intelligence was removed; see "Call transcripts today" in the reference section. Kept as history.]** **Transcripts: a refused request is marked `request_failed` and reported.** It fails Health Checks
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
- **[SUPERSEDED 2026-09-27 — Twilio Conversational Intelligence was removed; see "Call transcripts today" in the reference section. Kept as history.]** **Speaker-labelled call transcripts need TWO things set, and neither announces itself.**
  `TWILIO_INTELLIGENCE_SERVICE_SID` (a `GA...` Conversational Intelligence service) as a worker
  secret -- `deploy.yml` does not set it, wrangler secrets are separate -- AND **Dual-channel
  Recording for Conference** turned on in the Twilio Console (Voice > Settings). Without the secret
  nothing runs; without the toggle every recording comes back on one channel and is discarded
  unlabelled, because labelling a mono mix would be a guess presented as fact. Both states are
  reported by Admin > Health Checks, which is the answer to "is it on?" -- added precisely because
  `SERVICEM8_API_KEY` sat inert for a day with nothing saying so.
- **[SUPERSEDED 2026-09-27 — Twilio Conversational Intelligence was removed; see "Call transcripts today" in the reference section. Kept as history.]** **A mono recording never reached Health Checks, so the transcripts alarm could not fire.** Checked
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
- **[SUPERSEDED 2026-09-27 — Twilio Conversational Intelligence was removed; see "Call transcripts today" in the reference section. Kept as history.]** **Twilio has TWO Conversation Intelligence products and this uses the OLD one.** Searching the
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
- **[SUPERSEDED 2026-09-27 — Twilio Conversational Intelligence was removed; see "Call transcripts today" in the reference section. Kept as history.]** **Whisper and the Twilio sweep both write `call_transcript`, in the same cron tick.**
  `backfillTranscripts` can select a row with a NULL transcript, spend 10-30s in Workers AI, and land
  after the labelled text was written -- destroying it permanently, since the row is by then out of
  the sweep's query. `transcribeCallRecording` therefore guards its UPDATE on
  `intelligence_status <> 'completed'`. The guard belongs on the WRITE; the gap between read and
  write is where the race lives.
- **[SUPERSEDED 2026-09-27 — Twilio Conversational Intelligence was removed; see "Call transcripts today" in the reference section. Kept as history.]** **An empty transcript result is NOT the same as a mono recording.** `fetchSentences` returns
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

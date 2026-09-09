# Tier 2 Review Findings — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. This is the Tier 2 list
> deferred by `2026-09-09-divert-caller-id-regressions.md` — real defects found by the same whole-repo
> `/code-review`, but **pre-existing** rather than shipped that day, so they were split out rather
> than bundled into a regression fix.

**Goal:** Close eight independent defects that each fail silently. None of them throws, logs, or
turns anything red; every one of them is discovered by a person noticing that something did not
happen.

**Architecture:** No schema change, no new endpoint, no new setting. Seven are one-invariant fixes in
place; the eighth extracts a two-line helper (`src/html/formatTime.ts`) so the three admin pages that
render a timestamp stop each making their own decision about the time zone.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, vitest (`@cloudflare/vitest-pool-workers`).

## Global Constraints

- Deploys run from `.github/workflows/deploy.yml` on push to `master`. **PRs run no CI**, so the
  scratchpad preflight is the only gate before merge.
- Verify with `npx tsc --noEmit` (never pipe into `head` — a pipe swallows the exit code).
- Worker tests via the scratchpad `localtest.sh`.
- **Worker and web only. No `mobile/` changes, so no `OTA_BUILD` bump and no OTA publish.** The
  handset already behaves correctly in every one of these cases — several of these fixes are the web
  page being brought up to what the handset already does.
- No migration.

## File Structure

- Modify `src/api/staff.ts` — remove a departing member's push tokens and user settings.
- Modify `src/api/auth.ts`, `src/access/passwordTokens.ts` — a completed reset invalidates the
  account's other outstanding tokens, via a helper in the module that owns the table.
- Modify `src/worker.ts`, `src/db/calls.ts` — a later recording callback cannot blank a stored
  recording; add `blankToNull`.
- Modify `src/html/pages/phone.ts` — persist Away; port the handset's missed-call rule.
- Add `src/html/formatTime.ts`; modify `callDetail.ts`, `liveCalls.ts`, `callbackRequests.ts`,
  `voicemail.ts`.
- Modify `src/html/pages/ivrFlow.ts`, `src/html/pages/messages.ts` — escape quotes.
- Modify `src/twilio/intelligence.ts`, `src/twilio/intelligenceQueue.ts` — an unreadable transcript
  is not a mono one.
- Modify `src/api/diagnostics.ts` — soften the mono wording it can no longer be certain of.
- Tests: `test/api/staffAdmin.test.ts`, `test/api/authReset.test.ts`, `test/worker.test.ts`,
  `test/twilio/intelligenceQueue.test.ts`.

---

### Task 1: A removed staff member's handset keeps receiving customers

**Files:** Modify `src/api/staff.ts`; test `test/api/staffAdmin.test.ts`

`handleRemoveStaff` destroys sessions, password tokens and login attempts — everything about the
**login**, nothing about the **handset**. `getPushTokensForType` selects every row in `push_tokens`
and filters only on the owner having switched that notification type off; it never checks the owner
still exists. So a person removed from the business keeps getting inbound customer texts pushed to
their personal phone, sender name and message body included, indefinitely, with nothing anywhere
saying so. `user_settings` goes with it, or a re-invite silently restores the old mobile number and
ring-my-mobile state onto a new person at the same address.

- [x] **Step 1:** Failing test — remove a member who has a push token, assert the row is gone.
- [x] **Step 2:** Delete `push_tokens` and `user_settings` for the email alongside the existing
      cleanup.
- [x] **Step 3:** Test passes.

### Task 2: An old reset link outlives the reset

**Files:** Modify `src/api/auth.ts`; test `test/api/authReset.test.ts`

`issueToken` always INSERTs, so two clicks of "Send reset" leave two valid tokens. Consuming one
marked only that one used — the other stayed live for the rest of its hour, and whoever held that
older email could set the password again afterwards and take the account. `handleRemoveStaff`
already clears `password_tokens` for exactly this reason, which is what makes the omission here an
oversight rather than a decision. The lockout counter goes too: someone who hit the 8-failure limit
and then legitimately reset their password would otherwise still be told "too many attempts" on the
very next login.

- [x] **Step 1:** Failing test — issue two tokens, consume one, assert the other is rejected.
- [x] **Step 2:** Delete the remaining `password_tokens` and `login_attempts` after
      `destroySessionsForEmail`.
- [x] **Step 3:** Test passes.
- [x] **Step 4:** Through `invalidateTokensForEmail` (new, in `passwordTokens.ts`) and the existing
      `clearAttempts`, not hand-written SQL. Both statements had two copies across modules that do
      not own either table, so anything schema-shaped — marking rows used to keep an audit trail,
      scoping invalidation to a purpose — had to find both to stay correct.

### Task 3: A second recording callback blanks the first one's recording

**Files:** Modify `src/worker.ts`, `src/db/calls.ts`; test `test/worker.test.ts`

`recording_duration` was COALESCEd; `recording_url` and `recording_sid` on the same statement were
not. A redelivery — or a `RecordingStatus` of absent/failed, which carries no `RecordingUrl` — wrote
NULL over both, after which `/api/calls/:id/recording` 404s for a call whose audio is sitting fine in
Twilio.

COALESCE alone does not finish it. This is a **form post**: a field Twilio has nothing to say about
can arrive either absent or empty, and only the absent one is undefined, so `?? null` lets `""`
through — and `""` is a value that survives COALESCE and blanks the column just as destructively
while reading like it is guarded. Hence `blankToNull`, beside `parseRecordingDuration`, which has
handled exactly this for the duration all along.

- [x] **Step 1:** Failing test — store a recording, post a callback with the fields omitted.
- [x] **Step 2:** Second failing test — post one with the fields present but empty.
- [x] **Step 3:** COALESCE all three and route the two strings through `blankToNull`.
- [x] **Step 4:** Both pass; both fail on revert (`expected '' to be 'https://api.twilio.com/REC2'`).
- [x] **Step 5:** Third test — this must **not** become first-write-wins. Two different recordings
      legitimately post under one `callSid` (a divert into the staff member's carrier voicemail
      records the conference; the caller then falls to business voicemail and records again), and
      the later real one wins. COALESCE returns its first NON-NULL argument, so it already does —
      the test is there so a future "simplification" cannot quietly change that.

### Task 4: The web Away button never told the server

**Files:** Modify `src/html/pages/phone.ts`

The handler called `highlightStatusButtons('away')` and focused the reason box. Available and
Offline both POST; Away — the one status that means "stop ringing me" — only changed the colour of
a dot. Every inbound call still rang that leg. The reason box still refines it afterwards; it is no
longer what makes Away take effect.

- [x] **Step 1:** `setStatus('away', ...)`.
- [x] **Step 2:** Open the reason box **synchronously first**. `setStatus` awaits the PUT before it
      highlights, and highlighting is what un-hides the wrapper — so focusing after the call focuses
      a `display:none` input and does nothing, and a failed PUT would leave no way to type a reason
      at all.
- [x] **Step 3:** Send **no** `awayReason`, and make an absent one mean "leave it" server-side
      (`null` still clears). The first attempt sent the box's value and prefilled the box from the
      roster — but `/api/staff` returns only `{email, role, status}` and omits the rest on purpose,
      so the prefill was dead code and the box always starts empty: sending its value wipes the
      reason on every Away click, which is the bug this step exists to prevent. Caught by
      `/security-review`, not `/code-review`. Preserving is scoped to `away`; any other status
      clears the reason said or unsaid, so the handset (which sends `{status}` only) cannot leave
      someone available carrying a stale one.

### Task 5: Web Recents marks the wrong calls missed

**Files:** Modify `src/html/pages/phone.ts`

The rule was `direction === 'inbound' && !c.ivr_path`. `CallSession` writes `ivr_path` on the
voicemail handoff, so **no call that reached voicemail was ever shown as missed** — precisely the set
that still needs ringing back. It failed the other way too: an answered call that ended before any
node set `ivr_path` showed as missed. The handset's `recents.tsx` already uses `answered` and
`event_count`, both of which `listCalls` ships; this ports that rule verbatim.

- [x] **Step 1:** Port `isMissed` from the handset.

> The block lives inside a TS template literal — **no backticks anywhere in it**, comments included.
> Three TS1005s came from exactly that.

### Task 6: Three admin pages render times in UTC

**Files:** Add `src/html/formatTime.ts`; modify `callDetail.ts`, `liveCalls.ts`, `callbackRequests.ts`, `voicemail.ts`

Workers run in UTC, so a bare `toLocaleString("en-AU")` renders a 9am Canberra call as 11pm the
previous day — and a callback request as though it came in last night. `voicemail.ts` and
`clientErrors.ts` already passed `{ timeZone: "Australia/Sydney" }` inline, which is what makes the
others an omission rather than a choice. One helper so the next page cannot get its own answer.

- [x] **Step 1:** Add `formatSydney` / `BUSINESS_TIME_ZONE`.
- [x] **Step 2:** Route all five pages through it — `voicemail.ts` and `clientErrors.ts` included,
      or the rule is false the moment it is written.
- [x] **Step 3:** No pass-through wrappers. `formatWhen`/`fmtWhen` were left as one-line aliases at
      first, which is the same per-page indirection this task exists to delete — the next page copies
      the wrapper rather than the helper.

> `phone.ts`'s in-browser clock code and `businessHours.ts` / `dateRules.ts` stay out of this
> deliberately: the first already runs in Canberra, and the other two make a routing decision rather
> than a label, so pointing them at a helper under `src/html/` would be the wrong direction.

### Task 7: The IVR editor and the messages page do not escape quotes

**Files:** Modify `src/html/pages/ivrFlow.ts`, `src/html/pages/messages.ts`

`textContent -> innerHTML` escapes `&`, `<` and `>` and **not** quotes, and both helpers' output is
spliced into double-quoted attribute values (`value="..."`, `data-num="..."`). An admin-entered
mailbox name or forward-to number containing a quote closes the attribute and can add an event
handler that runs in the authenticated admin page.

- [x] **Step 1:** `.replace(/"/g,"&quot;").replace(/'/g,"&#39;")` in both.

### Task 8: An unreadable transcript is reported as a Console misconfiguration

**Files:** Modify `src/twilio/intelligence.ts`, `src/twilio/intelligenceQueue.ts`, `src/api/diagnostics.ts`; test `test/twilio/intelligenceQueue.test.ts`

`fetchSentences` returned `[]` for a 502, a thrown fetch, and a transcript past the page cap — the
same value as a genuinely empty read. The sweep turns an empty result into the **terminal** status
`single_channel`, so the row left the pending query: a transcript Twilio actually holds was abandoned
for good, and Admin > Health Checks counted it as mono and told you to switch on a Console setting
that was never off.

It returns `null` for "could not read" now, and the sweep leaves that row pending. **Counting the
attempt is what makes that safe** — not all of these are transient (a transcript past
`MAX_SENTENCE_PAGES` fails identically on every tick), and an uncounted retry would hold one of the
five `BATCH` slots forever, starving every newer call behind it.

- [x] **Step 1:** `fetchSentences` returns `Sentence[] | null`; log `INTELLIGENCE_SENTENCES_FAILED`.
- [x] **Step 2:** The sweep `continue`s on `null`, incrementing `intelligence_polls`. The increment
      is not incidental — it is the only thing bounding the retry, and the first version of this
      lacked it while the comment beside it claimed otherwise.
- [x] **Step 3:** Tests — a 502 leaves it pending, keeps the Whisper text and counts the poll; the
      same failure at the limit is abandoned.
- [x] **Step 4:** A read that genuinely returns nothing gets its own terminal `no_speech`. Otherwise
      `formatLabelledTranscript([])` returns `""` and a silent call is stamped `single_channel` —
      the same wrong diagnosis, reached by the other door.
- [x] **Step 5:** Soften the diagnostics wording — a call where only one party spoke looks identical
      to a mono recording, so it says "check a recent one" rather than "turn the setting on".
- [x] **Step 6:** Count `abandoned`/`failed` on the check. Moving unreadable transcripts off
      `single_channel` removed the (wrong) alarm they used to raise; without this the trade is no
      alarm at all, in the one screen that exists because silence hid `SERVICEM8_API_KEY` for a day.

### Task 9: Record what these have in common

**Files:** Modify `CLAUDE.md`

- [x] **Step 1:** A bullet per invariant worth not rediscovering.

---

## Deliberately not done

- **A foreign key from `push_tokens` to `staff`.** It would make Task 1 unrepresentable rather than
  merely fixed, and the same argument applies to `user_settings`. It is a migration against a live
  table with rows that may already be orphaned by every removal to date, so it needs a cleanup pass
  first. Raise with Phill.
- **Rendering times through the browser's own locale.** Every screen here is staff in Canberra, and
  a business-hours decision shown in the reader's zone is worse, not better, when someone opens the
  dashboard from a plane.

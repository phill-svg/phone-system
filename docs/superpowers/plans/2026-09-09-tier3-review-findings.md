# Tier 3 Review Findings — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. Third round of the
> standing whole-repo audit, after `2026-09-09-divert-caller-id-regressions.md` (tier 1) and
> `2026-09-09-tier2-review-findings.md` (tier 2).

**Goal:** Eight defects in the parts of the repo the first two rounds never reached — `src/ivr/`,
`src/dial/`, the messaging layer and `src/facebook/`. Every one was verified in source before being
written down.

**The pattern, again:** none of these throws where anyone sees it. Two of them are the same shape as
the worst bug tier 1 fixed — a read on the ring path that can escape to the Durable Object's
catch-all and **hang up a live customer**.

**Architecture:** No schema change, no new endpoint, no new setting. Four are "must not throw / must
not silently discard" guards; three are input validation at the point of write; one moves a write
out of a `try` that was reporting failure for work that had succeeded.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, vitest (`@cloudflare/vitest-pool-workers`).

## Global Constraints

- Deploys run from `.github/workflows/deploy.yml` on push to `master`. **PRs run no CI**, so the
  scratchpad preflight is the only gate before merge.
- Verify with `npx tsc --noEmit` (never pipe into `head` — a pipe swallows the exit code).
- Worker tests via the scratchpad `localtest.sh`.
- **Worker only. No `mobile/` changes, so no `OTA_BUILD` bump and no OTA publish.**
- No migration.

## File Structure

- Modify `src/dial/ringQueue.ts`, `src/db/staff.ts` — nothing on the ring path may throw.
- Modify `src/db/messages.ts` — a status callback may not erase a recorded failure.
- Modify `src/api/messages.ts` — a message Twilio accepted is sent, whatever D1 then does.
- Modify `src/facebook/channelHealth.ts` — one failure is not an outage.
- Modify `src/facebook/backfill.ts` — a Page-level failure must not burn per-psid attempts.
- Modify `src/ivr/businessHours.ts` — a window must have `close > open`.
- Modify `src/ivr/dateRules.ts` — validate entries; make `MM-DD..MM-DD` work or reject it.
- Modify `src/ivr/flowEngine.ts` — a play node may not render TwiML that throws.

---

### Task 1: Nothing on the ring path may throw (again)

**Files:** Modify `src/dial/ringQueue.ts`, `src/db/staff.ts`; test `test/dial/ringQueue.test.ts`

Tier 1 established the invariant: a throw inside `startRing` escapes `handleMainWebhook` to the DO's
catch-all, which says "we're experiencing a technical issue" and **hangs up on a live customer** —
and via `performDeferredDial` does that to someone already waiting on hold. `callerId()` was fixed
for exactly this. `resolveRingTargets`, called one line away at `CallSession.ts:402`, has the same
exposure and was missed:

- `getUserSettings` is read **per on-shift person**, unguarded, inside the loop. One transient D1
  error and nobody's phone rings — the caller is hung up on instead of falling through to voicemail.
- `getStaffRoster` `JSON.parse`s every row's schedule. One malformed row takes down the whole
  roster read, so a single bad record hangs up every caller.

The fallback is obvious in both cases and strictly better than a hangup: a failed preferences read
rings the **softphone** (`client:{email}`, the behaviour when ring-my-mobile is off), and an
unparseable schedule drops that one person rather than everybody.

- [x] **Step 1:** Failing test — make `user_settings` unreadable, assert the ring still resolves a
      leg rather than throwing.
- [x] **Step 2:** try/catch the per-person read, log `RING_PREFS_LOOKUP_FAILED`, fall back to the
      softphone leg.
- [x] **Step 3:** Failing test — a malformed `schedule` value; assert the other staff still resolve.
- [x] **Step 4:** Tolerate the parse in `toPresenceRow`, log `STAFF_SCHEDULE_UNPARSEABLE`.
- [x] **Step 5:** *(from review)* Guard the **roster** read too. Guarding only the per-person read
      left the outer one a single D1 blip from the exact hangup this task exists to prevent — half a
      fix, with a comment claiming a whole one.
- [x] **Step 6:** *(from review)* Catching the `JSON.parse` **throw** is not enough: a column
      holding the literal text `null` parses fine, and `isWithinBusinessHours` then does
      `schedule[dayKey]` on it — a TypeError, back into the same hangup. Check the shape with the
      now-exported `isBusinessHoursSchedule`.
- [x] **Step 7:** *(from review)* `playFromConfig` in `CallSession` is the unfixed twin of Task 8's
      `playCommandFor`, and it runs **inside** `startRing`. Same normalisation, same test.

### Task 2: A status callback must not erase a recorded failure

**Files:** Modify `src/db/messages.ts`; test `test/db/messages.test.ts`

`updateMessageStatus` writes `status`, `error_code` and `error_message` unconditionally. Twilio's
status callbacks are not ordered, so a late `sent` landing after a `failed` overwrites the terminal
status **and NULLs the reason it failed**. The message then reads as fine in the app, and it drops
out of `checkMessengerChannelHealth`'s count — so the alert that exists to catch a Messenger outage
gets quieter exactly when the outage is worst.

Same class as tier 2's recording-callback COALESCE: a later callback may only add information.

- [x] **Step 1:** Failing test — `failed` then a late `sent`; assert the failure and its reason
      survive.
- [x] **Step 2:** Ignore a non-terminal status once a terminal one is stored; COALESCE the error
      fields so a callback that carries no error cannot blank one.
- [x] **Step 3:** *(from review)* Terminal-to-terminal stays allowed — ordering the terminals against
      each other would invent a progression Twilio does not promise. The comment said otherwise.

### Task 3: A message Twilio accepted has been sent

**Files:** Modify `src/api/messages.ts`; test `test/api/messages.test.ts`

`insertMessage` sits **inside** the send `try`. If D1 hiccups after Twilio returned a sid, the
handler answers 502 "Could not send the message" — for a message the customer has already received.
Staff resend, and the customer gets it twice. Worse, no row exists, so the status callback for that
sid is a permanent no-op and the message never appears in the thread at all.

The send and the bookkeeping are different failures and must be reported differently.

- [x] **Step 1:** Failing test — Twilio succeeds, the insert throws; assert 200 and the sid.
- [x] **Step 2:** Move the insert out of the send `try` into its own, logging
      `MESSAGE_INSERT_FAILED`.
- [x] **Step 3:** *(from review)* Guard a 2xx that carries no `sid`. `sendSms` only throws on
      `!res.ok`, so splitting the try/catch is precisely what would have turned that from a visible
      502 into a silent success.

### Task 4: One failed message is not a channel outage

**Files:** Modify `src/facebook/channelHealth.ts`; test `test/facebook/channelHealth.test.ts`

`if (count === 0) return;` — so **one** failure fires "Facebook Messenger may be down" and arms a
six-hour cooldown. A single recipient outside Meta's 24-hour window is enough, and it then silences
a real channel break starting a minute later. The cooldown is also stamped when zero push tokens
were sent to, so an alert nobody received still suppresses the next six hours of them.

- [x] **Step 1:** Failing test — one failure alerts nothing; the threshold does.
- [x] **Step 2:** Require a threshold, and arm the cooldown only when an alert actually went out.

### Task 5: A Page-level failure must not burn every psid's attempts

**Files:** Modify `src/facebook/backfill.ts`; test `test/facebook/backfill.test.ts`

When `fetchPageInboxNames` fails at the **Page** level — an expired or revoked token — the sweep
logs it and then runs the per-psid lookup for every pending psid anyway. Those fail too, each
incrementing `attempts`. Twelve ticks at thirty minutes is six hours, after which every pending psid
is past `MAX_NAME_ATTEMPTS` and excluded by the query **permanently**. Fix the token afterwards and
those names can never be backfilled; the manual refresh uses only the per-psid profile route, which
`pageInbox.ts` itself documents as refused with code 100 for ordinary customers.

A Page-level failure says nothing about whether an individual psid is readable, so it must not be
recorded as that psid's attempt.

- [x] **Step 1:** Failing test — a Page inbox failure leaves `attempts` untouched.
- [x] **Step 2:** ~~Skip the per-psid loop when the failure was Page-level.~~ **Wrong shape** — it
      stops the documented fallback whenever the Page call fails for *any* reason, and four existing
      tests said so. The rule is narrower: don't COUNT the attempt when the failure is about the
      token rather than the person (`isTokenLevelFailure`), so the per-psid fallback still runs.
- [x] **Step 3:** *(from review)* Include HTTP 5xx and 429. Only a **thrown** fetch produces "Could
      not reach…"; a Graph incident answering 502 with a non-JSON body landed on "Facebook returned
      HTTP 502." and counted after all — so the first version did not cover the outage it was
      written for.

### Task 6: A business-hours window must have `close > open`

**Files:** Modify `src/ivr/businessHours.ts`; test `test/ivr/businessHours.test.ts`

`isWithinBusinessHours` is `minutes >= open && minutes < close`. Nothing validates that `close` is
after `open`: `isDayWindow` checks only the `\d{2}:\d{2}` shape. So a day saved as `09:00`–`00:00`
(a natural way to write "until midnight") or an inverted window reads as **closed all day** — every
in-hours call routed to after-hours, and that person dropped off the ring roster, with the schedule
screen showing hours that look perfectly correct.

- [x] **Step 1:** Failing test — `09:00`–`00:00` no longer silently closes the day.
- [x] **Step 2:** Validate `close > open` in `isDayWindow`, in ONE place: the check was duplicated in
      `api/settings.ts` and `api/staff.ts` and both copies tested only the `\d{2}:\d{2}` shape.
- [x] **Step 3:** *(from review)* A close of `00:00` means **midnight**, not minute zero — rejecting
      it would make "open until midnight" inexpressible, which is a worse fix than the bug. It has to
      mean end-of-day in the matcher as well, or the day reads as closed all the same.
- [x] **Step 4:** *(from review)* Checked live D1 before deploying, since a tightened validator can
      lock an admin out of saving an already-stored bad row: all three `staff_users.schedule` rows
      and `settings.business_hours` have `close > open` and valid `HH:MM`. Nobody is locked out.

### Task 7: A closed date that does not parse must not read as "open"

**Files:** Modify `src/ivr/dateRules.ts`; test `test/ivr/dateRules.test.ts`

Unrecognised entries are silently skipped, so a mistyped holiday leaves the IVR open on the one day
of the year it mattered. And the `..` range branch compares against `ymd` (`YYYY-MM-DD`), so an
`MM-DD..MM-DD` range — the obvious extension of the supported bare `MM-DD` form — can never match:
`"2026-12-27" <= "12-31"` is false on the first character.

- [x] **Step 1:** Failing test — an `MM-DD..MM-DD` range across a recurring closure.
- [x] **Step 2:** Compare an all-`MM-DD` range against `md`, and a full-date range against `ymd`.
- [x] **Step 3:** Validate entries where they are written, so a typo is refused rather than ignored.
- [x] **Step 4:** *(from review)* Digit SHAPE is not enough. `"25-12"` (a day-first Christmas) and
      `"2026-13-01"` both match their regex, save cleanly, and can never fire — the same silent
      no-op, reached by a different door. Check real month/day, and refuse an inverted full-date
      range.
- [x] **Step 5:** *(from review)* Name the offending entry in the error. "Invalid config shape" sends
      you hunting through a list of dates for the one that is wrong, which is the whole problem.

### Task 8: A play node may not render TwiML that throws

**Files:** Modify `src/ivr/flowEngine.ts`; test `test/ivr/flowEngine.test.ts`

`renderCommand` **throws** when a PLAY carries both `audioAssetId` and `ttsText` — deliberately,
as a defensive check. But `playCommandFor` passes both straight through when both are set, and
`isPlayConfig` permits it: the only thing holding that invariant is the browser JavaScript in the
IVR editor. A config that violates it hangs up **every caller** who reaches that node. Separately,
`config.audioAssetId ?? null` lets `""` through — `""` is not null — and renders
`<Play>{origin}/media/</Play>`, a 404 played at the caller.

- [x] **Step 1:** Failing test — a node config with both set, and one with `""`.
- [x] **Step 2:** Normalise blank to null and pick one deterministically, so the flow degrades to
      something playable instead of throwing.
- [x] **Step 3:** *(from review)* Do the same to `CallSession.playFromConfig` — see Task 1 Step 7.
      That copy is the one on the hangup path, so fixing only this one would have left the dangerous
      half in place under a comment claiming the case was handled.

### Task 9: Record what these have in common

**Files:** Modify `CLAUDE.md`

- [x] **Step 1:** A bullet per invariant worth not rediscovering — above all that the ring path now
      has THREE reads that must not throw, and why that list is the thing to check.

---

## What the review of the fixes found

`/code-review` and `/security-review` over the eight fixes turned up nine defects **in the fixes
themselves**, folded in above rather than followed up. The two that mattered:

- **Task 1 was half a fix.** The per-person read was guarded and the **roster** read one line above
  it was not — a single D1 blip from the exact live-caller hangup the task exists to prevent, under
  a comment claiming it was handled. Its revert test fails with `no such table: staff_users`.
- **Task 8 had an unfixed twin.** `CallSession.playFromConfig` is the same function as
  `flowEngine.playCommandFor`, and it is the copy that runs inside `startRing`. Its revert test
  shows the caller never even reaching `<Enqueue>`.

`/security-review` found **no security vulnerabilities**, and confirmed specifically that the
dynamic placeholder list in `updateMessageStatus` is not injectable (the array is a module-level
literal and `.map(() => "?")` discards the element), and that both new fallbacks are fail-CLOSED —
neither can make someone ring who was not already on shift.

## Deliberately not done

- **`startRing`'s `viaWait` path drops an accumulated PLAY.** *(Still not done — the `playFromConfig`
  fix above touches the same function but not this behaviour.)* A greeting configured as
  `play → wait → ring` never plays, because only the wait node's own hold content is used. Real, but
  the live flow has no wait node, so it is latent rather than active — and it is in `CallSession`,
  which this round deliberately left alone as tier 1's territory. Raise separately.
- **A foreign key from `user_settings` to `staff_users`.** Would make Task 1's fallback unnecessary
  for one of its two causes, but not for a transient read failure, which is the case that matters.

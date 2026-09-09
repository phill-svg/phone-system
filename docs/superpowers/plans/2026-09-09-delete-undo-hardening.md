# Delete/Undo Hardening — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. Written after
> `/code-review` on #69 found that the timestamp fix closed the reported bug but left three real
> defects and one flake source around it.

**Goal:** Make "delete a conversation, tap Undo" reliable in every case, and stop the deletion tests
being able to go red on timing again.

**Background:** #69 fixed the undo token drifting from the stored stamp (`handleDeleteThread` read
`Date.now()` twice). That was found only because deploy #75 went red on a docs-only commit. The
review of that fix found the surrounding code has the same shape of problem in three more places.

**Architecture:** No schema change and no new endpoint. The undo token stays the `deleted_at`
millisecond; what changes is that (a) nothing else mutates hidden rows behind it, (b) the token is
recoverable from logs when the client loses it, and (c) the tests stop depending on wall-clock
granularity.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, vitest (`@cloudflare/vitest-pool-workers`).

## Global Constraints

- Deploys run from `.github/workflows/deploy.yml` on push to `master`. **PRs run no CI**, so the
  preflight script is the only gate before merge.
- Verify with `npx tsc --noEmit` (never pipe into `head` — a pipe swallows the exit code).
- Worker tests via the scratchpad `localtest.sh` (strips the `ai`/`send_email` bindings, which
  otherwise demand a Cloudflare login this sandbox does not have).
- Worker-only. No `OTA_BUILD` bump, no OTA publish.
- **Do not widen to `softDeleteCall`.** It reads its own `Date.now()` too, but `restoreCall` matches
  on `id` and `deleted_at IS NOT NULL` — never on the stamp — so no drift is possible there. Threading
  a parameter through it would be ceremony against a hypothetical.

## File Structure

- Modify `src/db/messages.ts` — `markThreadRead` gains `AND deleted_at IS NULL`.
- Modify `src/api/deletions.ts` — `THREAD_DELETED` logs `deletedAt`.
- Modify `test/api/deletions.test.ts` — deterministic clock on the older test; assert the stored
  stamp; cover the read-state bug and the non-admin undo guard.
- Modify `CLAUDE.md` — record the invariant.

---

### Task 1: Stop a hidden thread being mutated behind the undo

**Files:** Modify `src/db/messages.ts`; test `test/api/deletions.test.ts`

A deleted conversation is still reachable by number — Recents, and the Message action on a call
detail, both route by peer rather than through the conversation list. `markThreadRead` updated every
inbound row for that peer, hidden ones included, so opening a deleted thread destroyed the unread
state that Undo is supposed to restore. The badge never comes back and unanswered texts read as
handled.

- [x] **Step 1:** Failing test — delete a thread, call `markThreadRead`, undo, assert `read === 0`.
- [x] **Step 2:** Add `AND deleted_at IS NULL` to the `markThreadRead` UPDATE.
- [x] **Step 3:** Test passes.

### Task 2: Make the undo token recoverable when the client loses it

**Files:** Modify `src/api/deletions.ts`

The token lives only in the client's undo alert. Dismiss it (Android back, an app restart) and the
documented recovery is "someone with D1 access" — who has the peer and the time to the second from
`wrangler tail`, but not the millisecond, so they must query the distinct `deleted_at` values and
guess between them.

- [x] **Step 1:** Add `deletedAt` to the `THREAD_DELETED` log line.

### Task 3: Stop the deletion tests depending on the clock

**Files:** Modify `test/api/deletions.test.ts`

`undo restores only the messages that delete hid` asserts `secondStamp !== firstStamp`. Two
back-to-back deletes CAN land in one millisecond on a warm isolate — and if they did, restoring the
second stamp would also un-hide the first's messages. That is a sibling of the bug that just took
master red.

- [x] **Step 1:** Force a monotonic `Date.now()` in that test, as the #69 regression test does.
- [x] **Step 2:** Assert the STORED stamp equals the returned one — the #69 test is named
      "returns the stamp it actually stored" but only checks that undo returns 200, so it would
      still pass if `restoreThread` ever fell back to matching on peer alone.

### Task 4: Cover the undo authorization guard

**Files:** Modify `test/api/deletions.test.ts`

Both delete handlers have a non-admin test; neither restore handler does. Dropping
`forbidden(staff)` from `handleRestoreThread` would let any staff member un-hide a business-wide
record the team deliberately removed, with nothing going red.

- [x] **Step 1:** Assert a non-admin undo returns 403 and the thread stays hidden.

### Task 5: Record the invariant

**Files:** Modify `CLAUDE.md`

- [x] **Step 1:** One bullet: the undo token is a timestamp matched exactly, so nothing may
      re-read the clock and nothing may mutate hidden rows.

---

## Deliberately not done

- **A monotonic delete-batch id instead of a timestamp.** It would make drift and collision
  unrepresentable rather than merely unlikely, and would survive the client losing the token. It is
  a schema change plus a migration plus a client change, and the timestamp is sound once nothing
  re-reads the clock. Raise with Phill before doing it.
- **A partial index for the undo path.** `idx_messages_not_deleted` is
  `WHERE deleted_at IS NULL`, so it excludes exactly the rows an undo targets and every restore
  scans `messages`. Real, but the table is small and an undo is rare; not worth a migration yet.

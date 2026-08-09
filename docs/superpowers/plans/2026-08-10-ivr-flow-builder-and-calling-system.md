# Full Calling System: Configurable Flow Builder + Ring/Queue/Voicemail/Callback + Outbound Click-to-Call

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

The TCB VoIP phone system (`C:\Users\Phill\Claude\voip-phone-system`) has zero real calling capability today: the IVR menu is a **hardcoded 4-option menu** baked into `src/ivr/stateMachine.ts` (not editable without a code deploy), and reaching "connect me to staff" or "voicemail" just speaks a line and hangs up — no ring, no hold, no recording, no outbound calling. Nothing here has ever been touched by a real phone call (no Twilio number has ever been provisioned).

This plan replaces the hardcoded menu with a **configurable flow builder** — modeled directly on a real reference flow the business already uses on another provider (screenshot supplied): business-hours branch → play a recording → ring a group for N seconds → play another recording → menu (leave a message, or wait) → hold experience while ringing again for longer → voicemail, with a separate after-hours voicemail path — and builds the full ring/hold-queue/recording/callback/outbound-calling system on top of it. Everything is built together in one pass; the only thing deferred to the very last task is connecting a real Twilio number, since none has ever existed.

**Implementation decision (stated, not asked, so it's correctable):** the flow editor is a **structured list/form UI** (add/edit nodes in the dashboard, each with typed fields; add/edit digit→destination rows for menus) in the existing server-rendered-HTML style — not a drag-and-drop visual canvas. This codebase has no frontend framework; building a real canvas editor from scratch would be its own multi-week project. The underlying data model supports the same flow shapes as the reference diagram; only the editing *interface* differs from a visual canvas.

**New capability, directly from the reference diagram**: nodes can play an **uploaded audio recording** (not just synthesized `<Say>` text) — e.g., the welcome message, the "currently showing..." message, and each voicemail box's greeting are real recordings in the reference system. This needs actual file storage (R2 — new to this repo, but justified now: it's for *uploaded prompt audio*, not call recordings, which is a separate, still-deferred concern) plus a public route Twilio can fetch audio from, plus an upload UI.

## Reference flow (from the supplied diagram — the concrete shape this plan must be able to express)

```
[Business Hours: Australia/Sydney]
 ├─ Mon–Fri & Sun 08:00–24:00 ──▶ [Play: welcome recording]
 │                                  └▶ [Ring "tcb" group, 30s]
 │                                       └(no answer)▶ [Play: "currently showing..." recording]
 │                                            └▶ [Menu: 2 options]
 │                                                 ├─ Key 1 (leave a message) ──▶ [Voicemail: greeting "3"]
 │                                                 └─ No/wrong input ──▶ [Wait: hold experience]
 │                                                      └▶ [Ring "tcb" group, 500s]
 │                                                           └(no answer)▶ [Voicemail: greeting "3a"]
 └─ Any other time ──▶ [Voicemail: greeting "4 after-hours"]
```

## Node model (generic enough to express the diagram, and future flow edits, without a schema change per edit)

D1 tables (new migration):
```sql
CREATE TABLE ivr_audio_assets (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL, uploaded_at INTEGER NOT NULL
);

CREATE TABLE ivr_nodes (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,                 -- 'main' (single entry flow; business_hours node is the entry point)
  is_entry INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('business_hours','play','gather','ring','wait','voicemail')),
  config TEXT NOT NULL,               -- JSON, shape depends on `type` (see below)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```
`config` JSON per `type` (validated by a discriminated-union validator, one function per type, same style as the existing `isStaffRingList`/`isBusinessHoursSchedule` validators in `src/api/settings.ts`):
- `business_hours`: `{ openNextNodeId: string; closedNextNodeId: string }` (schedule itself reuses the existing `getBusinessHours`/`isWithinBusinessHours` — not duplicated per-node).
- `play`: `{ audioAssetId: string | null; ttsText: string | null; nextNodeId: string }` (exactly one of `audioAssetId`/`ttsText` set).
- `gather`: `{ audioAssetId: string | null; ttsText: string | null; options: { digit: string; nextNodeId: string }[]; defaultNextNodeId: string; retryLimit: number }`.
- `ring`: `{ target: "all" | "on_call_only"; strategy: "cascade" | "simultaneous"; timeoutSeconds: number; noAnswerNextNodeId: string }` — on answer, the call is bridged and the flow ends there (no `nextNodeId` needed for the answered case).
- `wait`: `{ audioAssetId: string | null; ttsText: string | null; allowCallbackStar: boolean; nextNodeId: string }` — `nextNodeId` must point at a `ring` node; the caller hears this node's hold content while that `ring` node's dialing happens in the background (mechanically identical to the earlier hold-queue design, just with per-node configurable content instead of one global message).
- `voicemail`: `{ audioAssetId: string | null; ttsText: string | null; mailboxLabel: string }` — terminal; `mailboxLabel` is free text for reporting (e.g. "3", "3a", "4 after-hours" in the reference diagram), stored on the resulting `calls` row.

Seed migration data: recreate the current hardcoded 4-option menu as `ivr_nodes` rows (one `gather` node with 4 options routing to 4 `ring` nodes with `target:"all"`, one with `is_priority`-equivalent behavior for the emergency option — see Task 6's `ring` semantics), so behavior is unchanged immediately after migration; the business then edits it toward the reference shape via the new UI.

## Global Constraints

- **`src/ivr/stateMachine.ts`'s pure hardcoded reducer is DELETED, not preserved.** The whole point of this plan is that the flow becomes data. Its test file is replaced by tests for the new graph-walking engine (Task 3), not kept alongside it.
- **The graph-walking "reducer" is inherently async** (it loads node/option rows from D1 each turn) — this is a deliberate structural change from the old pure-function reducer, not an oversight. Keep the D1 reads cheap (a handful of small indexed lookups per turn) and let `CallSession` own the async orchestration, matching its existing role.
- **R2 is now in scope, but only for uploaded prompt audio** (`ivr_audio_assets`), **not for call recordings** — those remain on Twilio's own hosted URLs per the earlier decision (still deferred: fetch-and-archive-to-R2 for recordings is a separate future phase). Don't conflate the two R2 use cases.
- **The `GET /media/:key` route that serves uploaded audio to Twilio must be public** (no Cloudflare Access gate) — Twilio's servers fetch it directly and cannot authenticate through Access. Uploading/managing assets through the dashboard stays staff-gated; only the raw fetch-for-playback route is public. Serve with a long cache lifetime (audio assets are immutable once uploaded — re-upload creates a new asset row/key rather than mutating one in place) and a restrictive `Content-Type`/no directory listing.
- **One Twilio Queue per call, named after the caller's CallSid**; staff-leg webhook URLs always carry the original caller's CallSid as an explicit query parameter (never rely on Twilio's own `CallSid` param on those requests — it refers to the staff leg). Recording-status callbacks matched the same way.
- **`ring` node semantics replace the old fixed `RouteTag` enum**: `target:"on_call_only"` (the diagram's implicit "emergency-priority" case) dials only `isOnCall`-flagged staff; `target:"all"` dials everyone. `strategy` (`cascade`/`simultaneous`) is per-`ring`-node, not a single global Settings toggle — this is more flexible than the earlier draft and matches the reference diagram having two *different* ring nodes (30s vs 500s) that could reasonably use different strategies.
- **AMD**: `machineDetection="Enable"` on `<Number>` only; no `asyncAmd*` attributes (REST-API-only, invalid in TwiML).
- **Simultaneous double-answer race**: design the second-to-answer staff leg to fail gracefully (queue already empty) rather than dead air.
- Per-node `<Record maxLength="120" timeout="5" playBeep="true">` for voicemail.
- Everything through the second-to-last task is unit/integration-testable without a live Twilio number (mocked webhooks, mocked `fetch` for outbound REST/R2). The last task is the first real call this system has ever handled — treat surprises there as expected discovery, fix forward.

---

## Part A — Flow engine (replaces the hardcoded IVR)

### Task 1: Migrations — audio assets + flow nodes (+ seed data)
**Files:** `migrations/0004_ivr_flow.sql`. Seed the current hardcoded menu as rows matching the existing behavior exactly (2 flows worth of nodes: today's main menu + after-hours menu, each `gather`→four `ring{target:"all"}` nodes, after-hours' single option → `ring{target:"on_call_only"}`, all no-answer/default paths → one shared `voicemail` node).
- [ ] Write the migration + seed INSERTs. Extend the migration-applies-cleanly test pattern.
No dependencies.

### Task 2: R2 bucket + audio asset storage
**Files:** `wrangler.jsonc` (add `r2_buckets` binding, e.g. `AUDIO_ASSETS`), `src/db/audioAssets.ts` (CRUD against `ivr_audio_assets`), `src/api/audioAssets.ts` (`POST /api/ivr/audio` multipart upload → R2 put + D1 row; `GET /api/ivr/audio` list, staff-gated), `src/worker.ts` new **public** `GET /media/:key` route streaming from R2.
- [ ] **Red/Green:** upload stores the blob under a generated key + content-type, returns the asset id; list returns all assets; `/media/:key` streams the right bytes/content-type for a known key, 404 for unknown; confirm `/media/:key` is reachable with **no** Access/staff-auth header (test this explicitly — it's a constraint, not an accident).
Depends on Task 1.

### Task 3: The flow-walking engine (replaces `reduce()`)
**Files:** Create `src/ivr/flowEngine.ts` (delete `src/ivr/stateMachine.ts` and its test file — this is a removal, not a deprecation). Test: `test/ivr/flowEngine.test.ts`.

```ts
export type FlowCommand =
  | { type: "PLAY"; audioAssetId: string | null; ttsText: string | null }
  | { type: "GATHER"; numDigits: number; timeoutSeconds: number; validDigits: string; action: string }
  | { type: "ENQUEUE" /* wait node */ }
  | { type: "DIAL_HANDOFF" /* ring node: hand off to Part B */ }
  | { type: "VOICEMAIL_HANDOFF" /* voicemail node: hand off to Part B */ }
  | { type: "HANGUP" };

export async function advanceFlow(
  db: D1Database,
  currentNodeId: string | null, // null = start at the flow's entry node
  event: { type: "ENTER" } | { type: "DIGIT"; digit: string } | { type: "TIMEOUT_OR_INVALID" },
  isAfterHours: boolean,
  attempt: number
): Promise<{ nextNodeId: string; attempt: number; commands: FlowCommand[] }>
```
Behavior: loads the node (and, for `business_hours`, evaluates `isAfterHours` to pick a branch — the schedule check itself stays in `CallSession`, reusing `getBusinessHours`/`isWithinBusinessHours`, passed in rather than re-fetched here, keeping this function's D1 access to node/option lookups only); walks straight through any non-interactive node types (`business_hours`, `play`, `wait`'s content) in one call, accumulating their commands, and stops at the first node that needs caller input or an external handoff (`gather`, `ring`'s dial handoff, `voicemail`'s record handoff) — mirrors how the old `CallSession` combined `CALL_INITIATED`+`GREETING_SPOKEN` into one webhook turn. On `gather`'s digit: if it matches an option, continue walking from that option's `nextNodeId`; if not (or `TIMEOUT_OR_INVALID`) and `attempt < retryLimit`, re-render the same gather with incremented attempt; if attempt exhausted, walk from `defaultNextNodeId`.
- [ ] **Red/Green:** walk the seeded default flow end-to-end (matches old hardcoded behavior byte-for-byte in terms of which digit reaches which outcome); walk a `business_hours`→`play`→`ring`→`gather`→(`voicemail` | `wait`→`ring`→`voicemail`) shape matching the reference diagram; retry-then-default-fallback; malformed/missing node data throws a clear error (not a silent hang).
Depends on Tasks 1, 2.

### Task 4: TwiML rendering for flow commands
**Files:** `src/twilio/flowTwiml.ts`. `PLAY` renders `<Play>{mediaUrl}</Play>` (via Task 2's public `/media/:key`) or `<Say>{escapeXml(ttsText)}</Say>` depending on which is set. `GATHER` matches the existing `<Gather>` shape. Others render nothing here — they're handled by Part B/C's own TwiML (Task 8/12).
- [ ] **Red/Green:** one case per command, `PLAY` with each of audio-asset vs TTS, XML-escaping.
Depends on Task 3.

---

## Part B — Ring / hold-queue / voicemail / callback (mostly the previously-designed queue architecture, now driven by `ring`/`wait`/`voicemail` node config instead of a fixed enum)

*(Architecture recap: Twilio's synchronous TwiML has no native "ring with hold music" verb, so a `wait`+`ring` pair enqueues the caller in a per-call-CallSid-named Twilio Queue while staff are dialed separately via outbound REST calls; a `ring` node with no preceding `wait` just dials directly with plain ringback, no queue needed, for the simple "ring group, no fancy hold" case like the diagram's first 30s ring.)*

### Task 5: Twilio outbound REST client
**Files:** `src/twilio/restClient.ts` — `createOutboundCall`, `cancelCall`. Test with mocked `fetch`.
- [ ] **Red/Green** per the earlier draft's exact contract (Basic auth, form body, throws on non-2xx).
No dependencies.

### Task 6: Ring-target resolution
**Files:** `src/dial/ringQueue.ts` — `resolveRingTargets(ringNodeConfig, ringList: StaffRingEntry[]): string[]` (`target:"all"` → everyone; `target:"on_call_only"` → only `isOnCall` entries, `[]` if none — must fall through to the node's `noAnswerNextNodeId` cleanly, not error).
- [ ] **Red/Green:** both targets, empty-on-call edge case.
Depends on Task 1 (needs `isOnCall`, added alongside the seed migration or its own small migration — fold into Task 1 if not already present on `StaffRingEntry`).

### Task 7: `reduceRingPlan` — per-ring-node dial/queue orchestration
**Files:** `src/dial/ringPlan.ts`. Same reducer rigor as before, but keyed to a `ring` node instance's config (`strategy`, `timeoutSeconds`, resolved number list) rather than a fixed tag. Covers: direct-ring (no wait) outcome → bridged or `noAnswerNextNodeId`; queued-ring (preceded by `wait`) outcome → bridged, `noAnswerNextNodeId` (queue exhausted), or callback-requested (star pressed) → logs to `callback_requests` and ends the call politely.
- [ ] **Red/Green:** port the earlier draft's transition coverage (cascade ring-down, simultaneous batch, exhaustion, star-press), parameterized by node config instead of hardcoded tag/strategy.
Depends on Tasks 5, 6.

### Task 8: Queue/ring TwiML + new worker routes
**Files:** `src/twilio/queueTwiml.ts`, `src/worker.ts` new routes: `/webhooks/twilio/hold`, `/webhooks/twilio/hold-digit`, `/webhooks/twilio/queue-left`, `/webhooks/twilio/agent-answer`, `/webhooks/twilio/agent-status`, `/webhooks/twilio/recording-status`, plus the existing `/webhooks/twilio` extended to hand off into Part B when the flow engine reaches a `ring`/`wait`/`voicemail` node.
- [ ] **Red/Green** per the earlier draft's route contracts (signature verification, query-param CallSid threading, last-write-wins recording match).
Depends on Tasks 4, 7.

### Task 9: `CallSession` rewrite — flow engine + ring/queue orchestration
**Files:** `src/durable-objects/CallSession.ts` (substantial rewrite), `test/durable-objects/CallSession.test.ts` (substantial rewrite — old tests assumed the hardcoded menu and immediate-hangup stubs; replace with tests driving the seeded default flow and a reference-diagram-shaped flow).
- [ ] **Red/Green:** DO storage becomes `{currentNodeId, attempt}` (flow position) + the ring/queue tracking keys from the earlier draft (`attempts`, `pendingLeaveReason`). Dispatch: flow-engine turns vs ring/queue-leg turns, same "which storage key is populated" pattern as before.
- [ ] New tests: full reference-diagram walk (business hours open → play → ring 30s no-answer → play → gather timeout → wait → ring 500s → voicemail with the right `mailboxLabel`) and the after-hours branch straight to its own voicemail.
Depends on Tasks 3, 4, 8.

### Task 10: `callback_requests` + `direction`/`recording_url`/`recording_sid` columns
**Files:** Fold into Task 1's migration or a small follow-up migration if sequencing separately — `calls.recording_url`, `calls.recording_sid`, `calls.direction`, `calls.mailbox_label`; `callback_requests` table; `src/db/callbackRequests.ts`.
- [ ] **Red/Green:** as in the earlier draft.
No new dependencies beyond Task 1.

---

## Part C — Outbound click-to-call

### Task 11: Outbound API + webhook
**Files:** `src/api/outboundCalls.ts`, `migrations` addition for `staff_users.mobile_number`, new worker route `/webhooks/twilio/click-to-call`.
- [ ] **Red/Green:** per the earlier draft (staff-gated, rings the staff's own phone first, then bridges to the target with business caller ID, records via direct CallSid match — no query-param workaround needed here, unlike Part B).
Depends on Tasks 5, 10.

---

## Part D — Dashboard: flow editor, audio upload, dialer, callback/settings views

### Task 12: Flow editor page
**Files:** `src/html/pages/ivrFlow.ts` (new), `src/api/ivrFlow.ts` (`GET/PUT /api/ivr/flows/main` — whole-flow-as-JSON replace, transactional delete+reinsert of that flow's nodes, same "save the whole blob" simplicity as existing Settings). List/add/edit/delete nodes; per-type config fields (audio-asset picker sourced from Task 2's list endpoint, or inline upload); digit-option rows for `gather` nodes; entry-node designation.
- [ ] **Red/Green** at the API layer (validation per node type, atomic replace, rejects a flow with a dangling `nextNodeId` reference). Manual verification for the page itself, per existing convention.
Depends on Tasks 2, 9.

### Task 13: Dialer + callback-requests + on-call/settings UI
**Files:** `src/html/pages/callHistory.ts` (dialer input+button), a callback-requests view, on-call checkbox on the existing staff-ring-list Settings UI.
- [ ] Manual verification per existing convention.
Depends on Tasks 10, 11.

---

## Part E — Operational (last, deliberately)

### Task 14: Connect the real number, verify everything
Not dispatchable to a subagent. Apply all migrations `--remote`, deploy, buy/verify the AU Twilio number, point its webhook at the deployed worker, then verify: the seeded default flow behaves like the old hardcoded menu; rebuild the flow via the editor to match the reference diagram and verify that end-to-end (open-hours ring→play→menu→wait→ring→voicemail, and the after-hours voicemail branch); uploaded audio actually plays over a real call; callback-star-press logs correctly; outbound click-to-call bridges correctly with business caller ID.

---

## Verification (before Task 14)
1. `npm test` full suite green. 2. `npm run typecheck`. 3. `npm run dev` manual simulated-webhook walkthrough of both the seeded flow and a reference-diagram-shaped flow. 4. Task 14.

# Ring-My-Mobile (Aircall-style) — Implementation Plan (Plan 2 of Workstream B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each staff member opt to also ring their personal mobile on inbound business calls, so the call rings their mobile **and** the softphones at once (first to answer wins) — gated by opening hours + their availability, independent of whether their softphone is online.

**Architecture:** Reuse the existing dial→bridge flow: any answered leg (softphone `client:` or PSTN) hits `/webhooks/twilio/agent-answer` and joins the caller's conference. We (1) split presence into "on-shift" vs "on-shift + softphone-online", (2) have `resolveRingTargets` additionally emit a PSTN leg for each opted-in on-shift staff member, encoded so the dial path knows the owning email, and (3) teach `dialStaff` to dial a PSTN target (no `?CallerNumber` custom param — that only works for `client:` identities). The opt-in + number live in the per-user `user_settings` store from Plan 1 (`ring_my_mobile`, `mobile_number`).

**Tech Stack:** Cloudflare Workers Durable Objects + D1, TypeScript, vitest (`@cloudflare/vitest-pool-workers`), Expo React Native (SDK 54).

## Global Constraints

- Worker deploy branch is `master`; the deployed worker is pushed from local and **diverges** from the repo — do **not** run `wrangler deploy` in this plan. Ship mobile via `eas update --branch preview` + an `OTA_BUILD` bump.
- Verify typecheck with `npx tsc --noEmit; echo $?` (never pipe through `head`). Mobile: `cd mobile && npx tsc --noEmit`.
- Server tests: `npx vitest run` from repo root. wrangler must be logged in (`npx wrangler whoami`) or the `ai` binding blocks the suite.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; NO Claude-Session URL trailer.
- **Ring gating (from the spec):** the mobile leg rings only when the staff member is `status = 'available'` AND within their business-hours `schedule` — it must NOT require a fresh softphone heartbeat (that's the point: catch the call when the app is closed).
- **Never dial a PSTN mobile with a `?CallerNumber=` custom param** — that mechanism is `client:`-identity only.
- The per-user keys already exist (Plan 1, `src/db/userSettings.ts`): `ring_my_mobile: boolean`, `mobile_number: string`.
- `user_settings` FK requires a `staff_users` row for the email — tests that write settings must seed staff first (D1's test env enforces FKs).

## File Structure

- Modify `src/dial/presence.ts` — add `isOnShift`; refactor `isStaffAvailable` to `isOnShift(...) && heartbeat-fresh`.
- Modify `src/dial/ringQueue.ts` — `resolveRingTargets` also emits `pstn:{email}|{e164}` legs for opted-in on-shift staff; reads `user_settings`.
- Modify `src/durable-objects/CallSession.ts` — `dialStaff` handles `pstn:` targets (PSTN dial, no CallerNumber, correct leg ownership).
- Modify `src/db/userSettings.ts` — export a `normalizeMobileE164` helper (shared validation).
- Create `mobile/src/app/call-forwarding.tsx` — toggle + number entry screen.
- Modify `mobile/src/app/(tabs)/settings.tsx` — the "Call Forwarding" row navigates to it, shows current state; bump `OTA_BUILD`.
- Tests: `test/dial/presence.test.ts` (extend), `test/dial/ringQueue.test.ts` (extend/create), `test/durable-objects/CallSession.test.ts` (add a ring-my-mobile case).

---

### Task 1: Split presence into on-shift vs online

**Files:**
- Modify: `src/dial/presence.ts`
- Test: `test/dial/presence.test.ts`

**Interfaces:**
- Produces:
  - `isOnShift(staff: StaffPresenceRow, now: Date): boolean` — `status === "available"` AND `isWithinBusinessHours(schedule, now)`. Ignores heartbeat.
  - `isStaffAvailable(staff, now)` unchanged in behavior = `isOnShift(staff, now) && heartbeat-fresh`.

- [ ] **Step 1: Write the failing test**

Add to `test/dial/presence.test.ts` (create if absent, following existing dial test style):

```typescript
import { describe, it, expect } from "vitest";
import { isOnShift, isStaffAvailable, HEARTBEAT_STALE_MS, type StaffPresenceRow } from "../../src/dial/presence";

const OPEN_ALL_DAY = {
  mon: { open: "00:00", close: "23:59" }, tue: { open: "00:00", close: "23:59" },
  wed: { open: "00:00", close: "23:59" }, thu: { open: "00:00", close: "23:59" },
  fri: { open: "00:00", close: "23:59" }, sat: { open: "00:00", close: "23:59" },
  sun: { open: "00:00", close: "23:59" },
};
const base = (over: Partial<StaffPresenceRow> = {}): StaffPresenceRow => ({
  email: "a@b.com", role: "staff", status: "available", awayReason: null,
  schedule: OPEN_ALL_DAY, lastHeartbeatAt: Date.now(), ringPriority: 100, ...over,
});

describe("isOnShift", () => {
  const now = new Date();
  it("true when available + within hours, regardless of heartbeat", () => {
    expect(isOnShift(base({ lastHeartbeatAt: null }), now)).toBe(true);
    expect(isOnShift(base({ lastHeartbeatAt: now.getTime() - HEARTBEAT_STALE_MS - 1 }), now)).toBe(true);
  });
  it("false when not available", () => {
    expect(isOnShift(base({ status: "away" }), now)).toBe(false);
  });
});

describe("isStaffAvailable still requires a fresh heartbeat", () => {
  const now = new Date();
  it("false when on-shift but heartbeat is stale", () => {
    expect(isStaffAvailable(base({ lastHeartbeatAt: now.getTime() - HEARTBEAT_STALE_MS - 1 }), now)).toBe(false);
  });
  it("true when on-shift with fresh heartbeat", () => {
    expect(isStaffAvailable(base(), now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dial/presence.test.ts`
Expected: FAIL — `isOnShift` is not exported.

- [ ] **Step 3: Implement**

In `src/dial/presence.ts`, replace the `isStaffAvailable` function with:

```typescript
// On-shift = available and within business hours. Deliberately ignores the softphone heartbeat:
// used to decide whether to ring a staff member's personal MOBILE, which should reach them even
// when their softphone/app is closed (see ring-my-mobile).
export function isOnShift(staff: StaffPresenceRow, now: Date): boolean {
  if (staff.status !== "available") return false;
  return isWithinBusinessHours(staff.schedule, now);
}

// Reachable via SOFTPHONE right now = on-shift AND a fresh heartbeat proves the app is online.
export function isStaffAvailable(staff: StaffPresenceRow, now: Date): boolean {
  if (!isOnShift(staff, now)) return false;
  if (staff.lastHeartbeatAt === null) return false;
  return now.getTime() - staff.lastHeartbeatAt <= HEARTBEAT_STALE_MS;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/dial/presence.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npx tsc --noEmit; echo $?` (expect `0`); `npx vitest run` (expect all green — confirms existing presence/ring/CallSession behavior unchanged, since `isStaffAvailable` is behaviorally identical).

```bash
git add src/dial/presence.ts test/dial/presence.test.ts
git commit -m "feat(presence): add isOnShift (available+hours, no heartbeat); isStaffAvailable = isOnShift + fresh heartbeat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `resolveRingTargets` emits mobile legs for opted-in staff

**Files:**
- Modify: `src/db/userSettings.ts` (add `normalizeMobileE164`)
- Modify: `src/dial/ringQueue.ts`
- Test: `test/dial/ringQueue.test.ts`

**Interfaces:**
- Consumes: `getUserSettings` (Plan 1), `isStaffAvailable`, `isOnShift` (Task 1).
- Produces:
  - `normalizeMobileE164(raw: string): string | null` — returns E.164 (`+61…`) for a valid AU mobile, else null.
  - `resolveRingTargets(db, target, now): Promise<string[]>` — unchanged signature and return TYPE (string[]), but the array now additionally contains `pstn:{email}|{e164}` entries for each opted-in, on-shift staff member. Softphone (`client:{email}`) entries are still emitted for staff who are `isStaffAvailable` (online). A staff member may appear as BOTH a `client:` and a `pstn:` entry.

  Ordering: client legs first (by existing ring priority), then pstn legs (same priority order). This keeps every existing test that has no opted-in mobile staff byte-for-byte identical.

- [ ] **Step 1: Write the failing test**

Create/extend `test/dial/ringQueue.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import { resolveRingTargets } from "../../src/dial/ringQueue";
import { setUserSettings } from "../../src/db/userSettings";

const OPEN = JSON.stringify({
  mon: { open: "00:00", close: "23:59" }, tue: { open: "00:00", close: "23:59" },
  wed: { open: "00:00", close: "23:59" }, thu: { open: "00:00", close: "23:59" },
  fri: { open: "00:00", close: "23:59" }, sat: { open: "00:00", close: "23:59" },
  sun: { open: "00:00", close: "23:59" },
});

async function seedStaff(email: string, opts: { online?: boolean; priority?: number } = {}) {
  const online = opts.online ?? true;
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, ring_priority) VALUES (?, 'staff', 1, 'available', ?, ?, ?)"
  ).bind(email, OPEN, online ? Date.now() : null, opts.priority ?? 100).run();
}

describe("resolveRingTargets ring-my-mobile", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_settings").run();
    await env.DB.prepare("DELETE FROM staff_users").run();
  });

  it("adds a pstn leg for an on-shift staff member who enabled ring_my_mobile", async () => {
    await seedStaff("phill@b.com");
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets).toContain("client:phill@b.com");
    expect(targets).toContain("pstn:phill@b.com|+61412345678");
  });

  it("rings the mobile even when the softphone is OFFLINE (stale heartbeat), if on-shift", async () => {
    await seedStaff("phill@b.com", { online: false });
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets).not.toContain("client:phill@b.com"); // softphone offline → no client leg
    expect(targets).toContain("pstn:phill@b.com|+61412345678"); // but the mobile still rings
  });

  it("no mobile leg when ring_my_mobile is off or the number is invalid", async () => {
    await seedStaff("a@b.com");
    await seedStaff("c@b.com");
    await setUserSettings(env.DB, "a@b.com", { ring_my_mobile: false, mobile_number: "0412345678" });
    await setUserSettings(env.DB, "c@b.com", { ring_my_mobile: true, mobile_number: "nope" });
    const targets = await resolveRingTargets(env.DB, "all", new Date());
    expect(targets.filter((t) => t.startsWith("pstn:"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dial/ringQueue.test.ts`
Expected: FAIL — no `pstn:` targets emitted.

- [ ] **Step 3: Add `normalizeMobileE164` to `src/db/userSettings.ts`**

```typescript
// Normalize an AU mobile to E.164 (+61…). Accepts "04xxxxxxxx", "+61…", "61…", with spaces.
// Returns null if it isn't a plausible AU mobile (must yield +614xxxxxxxx, 12 chars after +61 = 9 digits).
export function normalizeMobileE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  let e164: string | null = null;
  if (/^\+61\d{9}$/.test(digits)) e164 = digits;
  else if (/^61\d{9}$/.test(digits)) e164 = `+${digits}`;
  else if (/^0\d{9}$/.test(digits)) e164 = `+61${digits.slice(1)}`;
  if (!e164) return null;
  return /^\+614\d{8}$/.test(e164) ? e164 : null; // AU mobiles are +614xxxxxxxx
}
```

- [ ] **Step 4: Implement in `src/dial/ringQueue.ts`**

```typescript
import { getStaffRoster } from "../db/staff";
import { isStaffAvailable, isOnShift } from "./presence";
import { getUserSettings, normalizeMobileE164 } from "../db/userSettings";

export type RingNodeTarget = "all" | string[];

// Resolves the ordered list of legs to ring for a ring node. Softphone legs (`client:{email}`) are
// emitted for staff whose app is online (isStaffAvailable). Personal-mobile legs
// (`pstn:{email}|{e164}`) are additionally emitted for staff who enabled ring-my-mobile and are
// on-shift (available + within hours) — even if their softphone is offline, so the call reaches
// their cell when the app is closed. Client legs first (by ring priority), then pstn legs.
export async function resolveRingTargets(db: D1Database, target: RingNodeTarget, now: Date): Promise<string[]> {
  const roster = await getStaffRoster(db);
  const candidates = target === "all" ? roster : roster.filter((s) => target.includes(s.email));
  const onShift = candidates.filter((s) => isOnShift(s, now));
  onShift.sort((a, b) => a.ringPriority - b.ringPriority || a.email.localeCompare(b.email));

  const clientLegs: string[] = [];
  const pstnLegs: string[] = [];
  for (const s of onShift) {
    if (isStaffAvailable(s, now)) clientLegs.push(`client:${s.email}`);
    const prefs = await getUserSettings(db, s.email);
    if (prefs.ring_my_mobile) {
      const e164 = normalizeMobileE164(prefs.mobile_number);
      if (e164) pstnLegs.push(`pstn:${s.email}|${e164}`);
    }
  }
  return [...clientLegs, ...pstnLegs];
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/dial/ringQueue.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npx tsc --noEmit; echo $?` (expect `0`); `npx vitest run` (expect all green — existing CallSession/ring tests have no opted-in mobile staff, so `resolveRingTargets` returns the same `client:` arrays as before).

```bash
git add src/db/userSettings.ts src/dial/ringQueue.ts test/dial/ringQueue.test.ts
git commit -m "feat(ring): resolveRingTargets emits pstn mobile legs for opted-in on-shift staff

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `dialStaff` dials a PSTN mobile leg

**Files:**
- Modify: `src/durable-objects/CallSession.ts` (`dialStaff`)
- Test: `test/durable-objects/CallSession.test.ts` (add one case)

**Interfaces:**
- Consumes: ring targets from Task 2 (`client:{email}` or `pstn:{email}|{e164}`).
- Behavior: `dialStaff(number, callSid, origin, timeoutSeconds)` — when `number` starts with `pstn:`, parse `email` and `e164`; dial `To = e164` (the real mobile, NO `?CallerNumber=` suffix — custom params don't reach PSTN), `From = TWILIO_FROM_NUMBER`, same agent-answer/agent-status webhooks; then `recordCallLeg(sid, email, callSid)` with the parsed email. The `client:` path is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/durable-objects/CallSession.test.ts` (uses the file's existing helpers — `seedEntryGather`, `seedRing`, `seedStaff`, `stubFor`, `send`, `mainEvent`, `outboundDials`; and `setUserSettings` for the mobile opt-in). Note `seedStaff` here already seeds an available+online staff row:

```typescript
  it("ring-my-mobile: an opted-in staff member's mobile is dialed as a PSTN leg alongside the softphone", async () => {
    await seedEntryGather({ option1: "main_ring", defaultNextNodeId: "main_vm" });
    await seedRing("main_ring", { noAnswerNextNodeId: "main_vm" });
    await seedVoicemail("main_vm", "default");
    await seedStaff("phill@b.com");
    // opt this staff member into ring-my-mobile (import setUserSettings at the top of the file)
    await setUserSettings(env.DB, "phill@b.com", { ring_my_mobile: true, mobile_number: "0412345678" });

    const stub = stubFor("CA-rmm");
    await send(stub, mainEvent("CA-rmm"));
    await send(stub, mainEvent("CA-rmm", { digits: "1" }));

    const dialled = outboundDials(fetchMock);
    // softphone leg still dialed (with the CallerNumber custom param), plus the raw mobile as PSTN
    expect(dialled).toContain("client:phill@b.com?CallerNumber=61400000000");
    expect(dialled).toContain("+61412345678");
    // the PSTN leg carries NO CallerNumber suffix
    expect(dialled.some((d) => d.startsWith("+61412345678?"))).toBe(false);

    // the mobile leg's ownership is recorded against the staff email (mock sid = `sid-${To}`)
    const legs = await env.DB.prepare("SELECT staff_email FROM softphone_call_legs WHERE call_sid = ?")
      .bind("sid-+61412345678").first<{ staff_email: string }>();
    expect(legs?.staff_email).toBe("phill@b.com");
  });
```

(Add `import { setUserSettings } from "../../src/db/userSettings";` to the test file's imports if not present.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/durable-objects/CallSession.test.ts -t "ring-my-mobile"`
Expected: FAIL — the `pstn:` target is dialed verbatim as `To="pstn:phill@b.com|+61412345678"` (wrong), so neither assertion matches.

- [ ] **Step 3: Implement in `dialStaff`**

Replace the leadin of `dialStaff` (the `callerRow`/`to`/`email` computation and the `recordCallLeg` line) so it branches on target kind. Full replacement of the method body’s target-resolution section:

```typescript
  private async dialStaff(number: string, callSid: string, origin: string, timeoutSeconds?: number): Promise<string> {
    // A ring target is either a softphone identity ("client:{email}") or a personal mobile
    // ("pstn:{email}|{e164}", see resolveRingTargets). For a softphone we pass the real caller's
    // number as a custom Client param (CallerNumber); for a PSTN mobile we dial the number directly
    // (custom params don't reach the PSTN, and the mobile just shows our business From).
    let to: string;
    let ownerEmail: string;
    if (number.startsWith("pstn:")) {
      const rest = number.slice("pstn:".length);
      const sep = rest.indexOf("|");
      ownerEmail = rest.slice(0, sep);
      to = rest.slice(sep + 1);
    } else {
      ownerEmail = number.startsWith("client:") ? number.slice("client:".length) : number;
      const callerRow = await this.env.DB.prepare("SELECT caller_number FROM calls WHERE id = ?")
        .bind(callSid)
        .first<{ caller_number: string }>();
      to = callerRow?.caller_number
        ? `${number}?CallerNumber=${encodeURIComponent(callerRow.caller_number.replace(/^\+/, ""))}`
        : number;
    }
    const { sid } = await createOutboundCall(
      this.env.TWILIO_ACCOUNT_SID,
      this.env.TWILIO_API_KEY_SID,
      this.env.TWILIO_API_KEY_SECRET,
      {
        to,
        from: this.env.TWILIO_FROM_NUMBER,
        url: appendWebhookSecret(`${origin}/webhooks/twilio/agent-answer?callSid=${callSid}`, this.env.TWILIO_WEBHOOK_SECRET),
        statusCallback: appendWebhookSecret(`${origin}/webhooks/twilio/agent-status?callSid=${callSid}`, this.env.TWILIO_WEBHOOK_SECRET),
        statusCallbackEvent: ["completed"],
        timeoutSeconds: typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds : 20,
      }
    );
    await recordCallLeg(this.env.DB, sid, ownerEmail, callSid);
    return sid;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/durable-objects/CallSession.test.ts -t "ring-my-mobile"`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npx tsc --noEmit; echo $?` (expect `0`); `npx vitest run` (expect all green — existing `client:` behavior is byte-for-byte unchanged).

```bash
git add src/durable-objects/CallSession.ts test/durable-objects/CallSession.test.ts
git commit -m "feat(ring): dialStaff dials pstn mobile legs (no CallerNumber param, owner recorded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mobile — Call Forwarding / "Ring my mobile" screen

**Files:**
- Create: `mobile/src/app/call-forwarding.tsx`
- Modify: `mobile/src/app/(tabs)/settings.tsx`

**Interfaces:**
- Consumes: `useUserSettings()` (Plan 1) — `settings.ring_my_mobile`, `settings.mobile_number`, `update(...)`.

- [ ] **Step 1: Build the screen**

Create `mobile/src/app/call-forwarding.tsx`:

```tsx
import React, { useState } from "react";
import { ScrollView, View, TextInput } from "react-native";
import { Stack } from "expo-router";
import { Screen } from "../components/ui/Screen";
import { Group, Row } from "../components/ui/Grouped";
import { useTheme } from "../theme/theme";
import { useUserSettings } from "../lib/userSettings";

export default function CallForwardingScreen() {
  const t = useTheme();
  const { settings, update } = useUserSettings();
  const [number, setNumber] = useState(settings.mobile_number);

  return (
    <Screen>
      <Stack.Screen options={{ title: "Ring My Mobile" }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group title="Ring my mobile"
          footer="When on, incoming business calls ring your mobile as well as the app during your available hours — whoever answers first takes the call.">
          <Row icon="iphone" iconColor="#34C759" label="Ring my mobile"
            toggle={settings.ring_my_mobile} onToggle={(v) => update({ ring_my_mobile: v })} />
        </Group>
        <Group title="Mobile number" footer="Australian mobile, e.g. 0412 345 678.">
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              value={number}
              onChangeText={setNumber}
              onBlur={() => update({ mobile_number: number })}
              placeholder="0412 345 678"
              placeholderTextColor={t.colors.labelTertiary}
              keyboardType="phone-pad"
              style={{ color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
          </View>
        </Group>
      </ScrollView>
    </Screen>
  );
}
```

(If `Screen`/`Group`/`Row`/`useTheme` import paths differ from the settings screen's, match those — read `settings.tsx`'s imports.)

- [ ] **Step 2: Wire the Settings row + bump OTA**

In `mobile/src/app/(tabs)/settings.tsx`:
- Add `import { router } from "expo-router";` if not present.
- Replace the Call Forwarding row:

```tsx
          <Row icon="arrow.turn.up.right" iconColor="#0A84FF" label="Call Forwarding" value="Off" onPress={() => {}} chevron />
```

with:

```tsx
          <Row icon="arrow.turn.up.right" iconColor="#0A84FF" label="Ring My Mobile"
            value={settings.ring_my_mobile ? "On" : "Off"} chevron
            onPress={() => router.push("/call-forwarding")} />
```

(`settings` is already available from the `useUserSettings()` hook added in Plan 1 Task 5. If it isn't in scope in this component, add `const { settings } = useUserSettings();`.)

- Bump `const OTA_BUILD = "20";` → `const OTA_BUILD = "21";`.

- [ ] **Step 3: Typecheck**

Run: `cd mobile && npx tsc --noEmit; echo $?` (expect `0`).

- [ ] **Step 4: Commit**

```bash
git add "mobile/src/app/call-forwarding.tsx" "mobile/src/app/(tabs)/settings.tsx"
git commit -m "feat(mobile): ring-my-mobile settings screen (toggle + number) — OTA #21

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end verification (on-device)

**Files:** none.

- [ ] **Step 1: Publish OTA #21** (only with user consent — production)

Run: `cd mobile && npx eas update --branch preview --message "#21 ring-my-mobile settings"`

- [ ] **Step 2: Worker must be deployed** — the ring-my-mobile server logic (Tasks 1-3) only takes effect once the worker is deployed. This is the user's deploy step (per the diverged-prod-worker caution). Confirm with the user before relying on live behavior.

- [ ] **Step 3: On-device check**
- In the app: Settings → Ring My Mobile → toggle on, enter a real mobile, back out.
- From another phone, call the business number during business hours with that staff member marked available.
- Expect: the configured mobile rings **and** the softphone rings; answering on the mobile connects to the caller and the softphone stops.
- Toggle off → the mobile no longer rings.

---

## Self-Review

- **Spec coverage:** ring-my-mobile is per-user, additive (client + pstn legs), gated by opening hours + availability and NOT softphone-online (Task 1 `isOnShift`, Task 2), first-to-answer via the existing conference bridge (Task 3 reuses agent-answer), UI to opt in + set the number (Task 4). Recording, missed/voicemail push sends, and native audio/auto-answer/call-waiting remain for later plans (documented below).
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `isOnShift`/`isStaffAvailable` (Task 1), `normalizeMobileE164` + the `pstn:{email}|{e164}` encoding (Task 2) consumed verbatim by `dialStaff` (Task 3); `ring_my_mobile`/`mobile_number` match the Plan 1 `UserSettings` shape; `useUserSettings()` from Plan 1 used in Task 4.
- **No-regression guard:** every server task ends with a full `npx vitest run`; the `pstn:` legs only appear when a staff member has opted in, so all existing ring/CallSession assertions (which seed no opt-in) are unchanged.

## Follow-on plans (Workstream B remainder)

- **Plan 3 — Call Recording (business-wide, admin-gated)** honored in `queueTwiml.ts` + `/twiml/voice-app`, plus **missed-call & voicemail push sends** (then gated via `getPushTokensForType` from Plan 1).
- **Plan 4 — Native mobile:** Audio Routing + Bluetooth (`voice.getAudioDevices()`/`AudioDevice.select()`), Auto-Answer + Call Waiting (`voice.ts` invite handler).

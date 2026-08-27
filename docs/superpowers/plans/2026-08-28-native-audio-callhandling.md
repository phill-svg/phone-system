# Native Audio Routing/Bluetooth + Auto-Answer/Call-Waiting — Implementation Plan (Plan 4 of Workstream B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the last four device-side Settings behaviors real: **Audio Routing** (Earpiece/Speaker/Bluetooth picker, live during a call), **Bluetooth** (allow/block BT routing), **Auto-Answer** (auto-accept an incoming call), and **Call Waiting** (handle a 2nd incoming call while on one).

**Architecture:** The native Twilio Voice SDK (`voice.getAudioDevices()`/`AudioDevice.select()`/`AudioDevicesUpdated`, and the `CallInvite` handler) lives only in `mobile/src/lib/voice.ts`, which can't be unit-tested (native module). So the *decisions* — which audio device to select given the prefs, and what to do with an incoming invite given the current state — are extracted into **native-free, jest-testable** helper modules; `voice.ts` and the screens call them and perform the native side, verified on-device. These are per-device prefs (SecureStore via the existing `usePersistedBool`).

**Tech Stack:** Expo React Native (SDK 54), `@twilio/voice-react-native-sdk@2.0.0-preview.2`, TypeScript, jest (jest-expo) for the pure helpers, `expo-secure-store`.

## Global Constraints

- Mobile only — NO server changes, NO worker deploy. Ship via `eas update --branch preview` + an `OTA_BUILD` bump.
- Typecheck: `cd mobile && npx tsc --noEmit; echo $?` (never pipe through `head`).
- Mobile unit tests: `cd mobile && npx jest` (jest-expo). vitest ignores `mobile/`.
- **Pure logic must live in native-free modules** (no `import … from "@twilio/voice-react-native-sdk"`), so jest can import them without the native module. `voice.ts` imports the pure helpers, never the reverse.
- Native audio/call behaviors are verified **on-device** (they can't be unit-tested); each such task's deliverable is the wiring + typecheck + the pure-logic tests, with a device-verification step in Task 6.
- **Call Waiting MVP** = end-current-then-answer (or reject when off); true hold/swap of two simultaneous calls is NOT in scope (the v2-preview SDK's multi-call support is unverified).
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; NO Claude-Session URL trailer.
- The four prefs already exist as `usePersistedBool` keys in `settings.tsx`: `pref_call_waiting`, `pref_auto_answer`, `pref_bluetooth`; Audio Routing is currently a `() => {}` stub. Auto-Answer/Call-Waiting/Bluetooth toggles currently persist but do nothing.

## AudioDevice API (verified in the installed SDK)

- `voice.getAudioDevices(): Promise<{ audioDevices: AudioDevice[]; selectedDevice?: AudioDevice }>`
- `AudioDevice`: `.uuid`, `.type` (`AudioDevice.Type` = `"earpiece" | "speaker" | "bluetooth"`), `.name`, `.select(): Promise<void>`
- `voice.on(Voice.Event.AudioDevicesUpdated, (audioDevices, selectedDevice) => …)` (`Voice.Event.AudioDevicesUpdated === "audioDevicesUpdated"`)

## File Structure

- Create `mobile/src/lib/audioRouting.ts` — pure `chooseAudioDevice(...)` + the `AudioRoutePref` type (NO SDK import).
- Create `mobile/src/lib/callRouting.ts` — pure `decideInviteAction(...)` (NO SDK import).
- Create `mobile/__tests__/audioRouting.test.ts`, `mobile/__tests__/callRouting.test.ts` (jest).
- Modify `mobile/src/lib/voice.ts` — audio-device wrappers + apply route on call start; expose the pending-invite/active-call state the invite handler needs.
- Modify `mobile/src/app/(tabs)/_layout.tsx` — invite handler uses `decideInviteAction` (auto-answer, call-waiting).
- Modify `mobile/src/app/call-active.tsx` — real audio-route control (speaker button + picker), subscribe to `AudioDevicesUpdated`.
- Modify `mobile/src/app/call-incoming.tsx` — support auto-answer + the call-waiting "end & answer" path.
- Modify `mobile/src/app/(tabs)/settings.tsx` — wire Audio Routing (picker), Bluetooth, Auto-Answer, Call Waiting; bump `OTA_BUILD`.

---

### Task 1: Pure audio-device selection logic

**Files:**
- Create: `mobile/src/lib/audioRouting.ts`
- Test: `mobile/__tests__/audioRouting.test.ts`

**Interfaces:**
- Produces:
  - `type AudioRoutePref = "automatic" | "earpiece" | "speaker" | "bluetooth"`
  - `type AudioDeviceLike = { uuid: string; type: "earpiece" | "speaker" | "bluetooth"; name?: string }`
  - `chooseAudioDevice(devices: AudioDeviceLike[], pref: AudioRoutePref, bluetoothAllowed: boolean): AudioDeviceLike | null` — returns the device to `.select()`, or `null` to leave the SDK's current/automatic choice. Rules: if `pref` names a concrete type and a device of that type exists (and, for bluetooth, `bluetoothAllowed`), return it. For `"automatic"`: if a bluetooth device exists AND `bluetoothAllowed`, prefer it; else return `null` (let the SDK decide earpiece/speaker). If `bluetoothAllowed` is false, never return a bluetooth device (for any pref — a `"bluetooth"` pref with BT disallowed returns `null`).

- [ ] **Step 1: Write the failing test**

Create `mobile/__tests__/audioRouting.test.ts`:

```typescript
import { chooseAudioDevice, type AudioDeviceLike } from "../src/lib/audioRouting";

const ear: AudioDeviceLike = { uuid: "e", type: "earpiece" };
const spk: AudioDeviceLike = { uuid: "s", type: "speaker" };
const bt: AudioDeviceLike = { uuid: "b", type: "bluetooth" };

describe("chooseAudioDevice", () => {
  it("selects the device matching a concrete pref", () => {
    expect(chooseAudioDevice([ear, spk], "speaker", true)).toEqual(spk);
    expect(chooseAudioDevice([ear, spk], "earpiece", true)).toEqual(ear);
  });
  it("selects bluetooth for a bluetooth pref only when allowed", () => {
    expect(chooseAudioDevice([ear, bt], "bluetooth", true)).toEqual(bt);
    expect(chooseAudioDevice([ear, bt], "bluetooth", false)).toBeNull();
  });
  it("automatic prefers bluetooth when allowed, else null", () => {
    expect(chooseAudioDevice([ear, spk, bt], "automatic", true)).toEqual(bt);
    expect(chooseAudioDevice([ear, spk, bt], "automatic", false)).toBeNull();
    expect(chooseAudioDevice([ear, spk], "automatic", true)).toBeNull();
  });
  it("returns null when the preferred type is absent", () => {
    expect(chooseAudioDevice([ear], "bluetooth", true)).toBeNull();
    expect(chooseAudioDevice([ear], "speaker", true)).toBeNull();
  });
  it("never returns bluetooth when disallowed, even under automatic", () => {
    expect(chooseAudioDevice([bt], "automatic", false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest audioRouting`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/lib/audioRouting.ts`**

```typescript
// Pure audio-route selection logic — deliberately NO native SDK import so jest can test it.
// voice.ts maps the SDK's AudioDevice[] into AudioDeviceLike[] and calls this to decide what to select.

export type AudioRoutePref = "automatic" | "earpiece" | "speaker" | "bluetooth";
export type AudioDeviceLike = { uuid: string; type: "earpiece" | "speaker" | "bluetooth"; name?: string };

export function chooseAudioDevice(
  devices: AudioDeviceLike[],
  pref: AudioRoutePref,
  bluetoothAllowed: boolean,
): AudioDeviceLike | null {
  const find = (t: AudioDeviceLike["type"]) => devices.find((d) => d.type === t) ?? null;

  if (pref === "bluetooth") return bluetoothAllowed ? find("bluetooth") : null;
  if (pref === "speaker") return find("speaker");
  if (pref === "earpiece") return find("earpiece");

  // automatic: prefer a connected bluetooth device when allowed; otherwise let the SDK decide.
  if (bluetoothAllowed) {
    const bt = find("bluetooth");
    if (bt) return bt;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest audioRouting`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`).

```bash
git add mobile/src/lib/audioRouting.ts mobile/__tests__/audioRouting.test.ts
git commit -m "feat(audio): pure chooseAudioDevice selection logic (jest-tested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Audio-device wrappers in voice.ts + apply route on call start

**Files:**
- Modify: `mobile/src/lib/voice.ts`
- Modify: `mobile/src/lib/prefs.ts` (add a persisted-string helper if none exists — see below)

**Interfaces:**
- Consumes: `chooseAudioDevice`, `AudioRoutePref` (Task 1).
- Produces (from `voice.ts`):
  - `listAudioDevices(): Promise<{ devices: AudioDeviceLike[]; selectedType: "earpiece"|"speaker"|"bluetooth"|null }>`
  - `selectAudioRoute(pref: AudioRoutePref): Promise<void>` — reads the bluetooth pref, maps SDK devices → `AudioDeviceLike[]`, calls `chooseAudioDevice`, and `.select()`s the result (no-op when null).
  - `onAudioDevicesUpdated(cb: (selectedType: "earpiece"|"speaker"|"bluetooth"|null) => void): () => void` — subscribes to `Voice.Event.AudioDevicesUpdated`, returns unsubscribe.
  - `applyDefaultAudioRoute(): Promise<void>` — reads the saved `AudioRoutePref` + bluetooth pref and applies it; call this right after a call connects.

- [ ] **Step 1: Add a persisted-string helper** (if `prefs.ts` only has `usePersistedBool`)

Read `mobile/src/lib/prefs.ts`. If there is no string variant, add non-hook getters/setters usable outside React (voice.ts is not a component):

```typescript
import * as SecureStore from "expo-secure-store";
export async function getPref(key: string, fallback: string): Promise<string> {
  try { return (await SecureStore.getItemAsync(key)) ?? fallback; } catch { return fallback; }
}
export async function setPref(key: string, value: string): Promise<void> {
  try { await SecureStore.setItemAsync(key, value); } catch { /* ignore */ }
}
export async function getPrefBool(key: string, fallback: boolean): Promise<boolean> {
  const v = await getPref(key, fallback ? "1" : "0");
  return v === "1";
}
```

Pref keys (device-local): `pref_audio_route` (an `AudioRoutePref`, default `"automatic"`), `pref_bluetooth` (bool, default `true`, already used by the settings toggle).

- [ ] **Step 2: Implement the wrappers in `voice.ts`**

Add (near the other exports; `voice` is the existing `Voice` instance, `Call`/`Voice` already imported — add `AudioDevice` to the SDK import if needed):

```typescript
import { chooseAudioDevice, type AudioRoutePref, type AudioDeviceLike } from "./audioRouting";
import { getPref, getPrefBool } from "./prefs";

function toLike(d: { uuid: string; type: string; name?: string }): AudioDeviceLike {
  return { uuid: d.uuid, type: d.type as AudioDeviceLike["type"], name: d.name };
}

export async function listAudioDevices() {
  const { audioDevices, selectedDevice } = await voice.getAudioDevices();
  return {
    devices: audioDevices.map(toLike),
    selectedType: (selectedDevice?.type as AudioDeviceLike["type"] | undefined) ?? null,
  };
}

export async function selectAudioRoute(pref: AudioRoutePref): Promise<void> {
  const { audioDevices } = await voice.getAudioDevices();
  const bluetoothAllowed = await getPrefBool("pref_bluetooth", true);
  const target = chooseAudioDevice(audioDevices.map(toLike), pref, bluetoothAllowed);
  if (!target) return;
  const match = audioDevices.find((d) => d.uuid === target.uuid);
  if (match) await match.select();
}

export async function applyDefaultAudioRoute(): Promise<void> {
  const pref = (await getPref("pref_audio_route", "automatic")) as AudioRoutePref;
  await selectAudioRoute(pref).catch(() => {});
}

export function onAudioDevicesUpdated(cb: (selectedType: AudioDeviceLike["type"] | null) => void): () => void {
  const handler = (_devices: unknown, selected?: { type?: string }) =>
    cb((selected?.type as AudioDeviceLike["type"] | undefined) ?? null);
  voice.on(Voice.Event.AudioDevicesUpdated, handler);
  return () => voice.off(Voice.Event.AudioDevicesUpdated, handler);
}
```

- [ ] **Step 3: Apply the default route when a call connects**

In `placeCall` and `acceptIncoming` (voice.ts), after the call is obtained/answered, call `applyDefaultAudioRoute()` (fire-and-forget: `applyDefaultAudioRoute().catch(() => {})`). This sets the user's saved route once audio is live.

- [ ] **Step 4: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`). (No jest here — these are native wrappers; the logic they call is already tested in Task 1.)

```bash
git add mobile/src/lib/voice.ts mobile/src/lib/prefs.ts
git commit -m "feat(audio): voice.ts audio-device wrappers; apply saved route on call connect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Real audio-route control on the active-call screen

**Files:**
- Modify: `mobile/src/app/call-active.tsx`

**Interfaces:**
- Consumes: `listAudioDevices`, `selectAudioRoute`, `onAudioDevicesUpdated` (Task 2); `setPref` (Task 2).

- [ ] **Step 1: Make the speaker button real + reflect live state**

Read `call-active.tsx`. Today the `speaker` state is UI-only (`onPress={() => setSpeaker((s) => !s)}`). Change it so:
- On mount (call active), subscribe via `onAudioDevicesUpdated` to keep `speaker` in sync with whether the selected device is `speaker`; unsubscribe on unmount.
- The speaker button toggles between `speaker` and `earpiece` by calling `selectAudioRoute("speaker")` / `selectAudioRoute("earpiece")` and persisting the choice via `setPref("pref_audio_route", …)`.
- If a bluetooth device is present in `listAudioDevices()`, show a third state / a small route picker (Automatic / Earpiece / Speaker / Bluetooth) that calls `selectAudioRoute(pref)` + persists it. If no BT device is present, the existing 2-way speaker/earpiece button is enough — keep the UI minimal and match the existing `Control` component style.

Keep `toggleMute` and the rest of the screen unchanged.

- [ ] **Step 2: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`).

```bash
git add "mobile/src/app/call-active.tsx"
git commit -m "feat(audio): active-call speaker/route control wired to AudioDevice selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Pure invite-decision logic

**Files:**
- Create: `mobile/src/lib/callRouting.ts`
- Test: `mobile/__tests__/callRouting.test.ts`

**Interfaces:**
- Produces:
  - `type InviteAction = "answer-now" | "show-incoming" | "show-waiting" | "reject"`
  - `decideInviteAction(state: { hasActiveCall: boolean; autoAnswer: boolean; callWaiting: boolean }): InviteAction` — rules:
    - No active call: `autoAnswer ? "answer-now" : "show-incoming"`.
    - Active call exists (2nd invite): `callWaiting ? "show-waiting" : "reject"`. (Auto-answer never applies to a 2nd call — you're already talking.)

- [ ] **Step 1: Write the failing test**

Create `mobile/__tests__/callRouting.test.ts`:

```typescript
import { decideInviteAction } from "../src/lib/callRouting";

describe("decideInviteAction", () => {
  it("first call: auto-answer on → answer-now, off → show-incoming", () => {
    expect(decideInviteAction({ hasActiveCall: false, autoAnswer: true, callWaiting: false })).toBe("answer-now");
    expect(decideInviteAction({ hasActiveCall: false, autoAnswer: false, callWaiting: false })).toBe("show-incoming");
  });
  it("second call: call-waiting on → show-waiting, off → reject", () => {
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: false, callWaiting: true })).toBe("show-waiting");
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: false, callWaiting: false })).toBe("reject");
  });
  it("second call never auto-answers", () => {
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: true, callWaiting: true })).toBe("show-waiting");
    expect(decideInviteAction({ hasActiveCall: true, autoAnswer: true, callWaiting: false })).toBe("reject");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mobile && npx jest callRouting`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/lib/callRouting.ts`**

```typescript
// Pure incoming-invite decision — NO native import, so jest can test it. The invite handler in
// (tabs)/_layout.tsx maps this decision to navigation / accept / reject on the native Call.
export type InviteAction = "answer-now" | "show-incoming" | "show-waiting" | "reject";

export function decideInviteAction(state: {
  hasActiveCall: boolean;
  autoAnswer: boolean;
  callWaiting: boolean;
}): InviteAction {
  if (state.hasActiveCall) return state.callWaiting ? "show-waiting" : "reject";
  return state.autoAnswer ? "answer-now" : "show-incoming";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd mobile && npx jest callRouting` → PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`).

```bash
git add mobile/src/lib/callRouting.ts mobile/__tests__/callRouting.test.ts
git commit -m "feat(calls): pure decideInviteAction (auto-answer / call-waiting) — jest-tested

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire auto-answer + call-waiting into the invite handler

**Files:**
- Modify: `mobile/src/app/(tabs)/_layout.tsx`
- Modify: `mobile/src/app/call-incoming.tsx`
- Modify: `mobile/src/lib/voice.ts` (expose `getActiveCall()` — already exists — and ensure `getPrefBool` reads the toggles)

**Interfaces:**
- Consumes: `decideInviteAction` (Task 4), `getActiveCall`, `acceptIncoming`, `rejectIncoming` (voice.ts), `getPrefBool` (Task 2).

- [ ] **Step 1: Update the invite handler in `(tabs)/_layout.tsx`**

Read `(tabs)/_layout.tsx` (the `registerForIncoming((from) => { … })` at ~line 16, which today just navigates to `/call-incoming`). Change the handler to be async and use the decision:

```tsx
registerForIncoming(async (from) => {
  const hasActiveCall = getActiveCall() !== null;
  const autoAnswer = await getPrefBool("pref_auto_answer", false);
  const callWaiting = await getPrefBool("pref_call_waiting", true);
  const action = decideInviteAction({ hasActiveCall, autoAnswer, callWaiting });
  if (action === "reject") { rejectIncoming().catch(() => {}); return; }
  if (action === "answer-now") {
    // Navigate to the active-call screen in incoming mode with an auto-accept flag.
    router.push({ pathname: "/call-incoming", params: { number: from, name: "", auto: "1" } });
    return;
  }
  // show-incoming and show-waiting both open the ringing screen; "waiting" adds context.
  router.push({ pathname: "/call-incoming", params: { number: from, name: "", waiting: action === "show-waiting" ? "1" : "" } });
});
```

(Import `getActiveCall`, `rejectIncoming`, `getPrefBool`, `decideInviteAction`; keep the existing imports/registration lifecycle.)

- [ ] **Step 2: Auto-answer + call-waiting behavior in `call-incoming.tsx`**

Read `call-incoming.tsx`. Add:
- If `params.auto === "1"`, auto-invoke the existing accept flow shortly after mount (e.g. a 1.5s timer, cancelled if the user acts first), so the call connects hands-free.
- If `params.waiting === "1"`, this is a second call while one is active. MVP: show a "Call waiting — answering will end your current call" note; on accept, END the current active call first (`getActiveCall()?.disconnect()`), then `acceptIncoming()` as usual. On reject, `rejectIncoming()` (declines just the 2nd call, current call continues).

Keep the normal (first-call, no-auto) path exactly as today.

- [ ] **Step 3: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`).

```bash
git add "mobile/src/app/(tabs)/_layout.tsx" "mobile/src/app/call-incoming.tsx" mobile/src/lib/voice.ts
git commit -m "feat(calls): auto-answer + call-waiting handling on incoming invites (MVP)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Settings wiring + OTA bump

**Files:**
- Modify: `mobile/src/app/(tabs)/settings.tsx`

- [ ] **Step 1: Wire the four rows**

Read `settings.tsx`. The Call Waiting / Auto-Answer / Bluetooth toggles already use `usePersistedBool` with the keys `pref_call_waiting` / `pref_auto_answer` / `pref_bluetooth` — those now drive real behavior (Tasks 2, 5), so no code change is needed for them beyond confirming the keys match. Update the footers to describe the real behavior (e.g. Auto-Answer: "Automatically answer incoming calls after a moment."; Bluetooth: "Allow routing call audio to Bluetooth devices.").

Replace the **Audio Routing** row (currently `value="Automatic" onPress={() => {}}`) with a real control: a segmented/picker or a press-through that cycles/sets `pref_audio_route` (`Automatic / Earpiece / Speaker / Bluetooth`) via `getPref`/`setPref`, showing the current value. Since audio devices are only meaningful during a call, this row sets the DEFAULT route applied on the next call (`applyDefaultAudioRoute` reads it). Keep it consistent with the existing Settings UI (e.g. reuse the `Segmented` component the Appearance row uses, or a `Row` that opens a small picker).

- [ ] **Step 2: Bump OTA**

`const OTA_BUILD = "22";` → `const OTA_BUILD = "23";`.

- [ ] **Step 3: Typecheck + commit**

Run: `cd mobile && npx tsc --noEmit; echo $?` (`0`).

```bash
git add "mobile/src/app/(tabs)/settings.tsx"
git commit -m "feat(mobile): wire Audio Routing / Bluetooth / Auto-Answer / Call Waiting settings — OTA #23

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: On-device verification

**Files:** none.

- [ ] **Step 1** (user-consent): `cd mobile && npx eas update --branch preview --message "#23 native audio routing + auto-answer/call-waiting"`.
- [ ] **Step 2 — on-device (requires the native build):**
  - **Audio Routing:** during a call, the speaker button routes to speaker/earpiece; with a Bluetooth headset paired, the picker offers Bluetooth and selecting it routes there; the shown state tracks the actual device (unplug BT → falls back). The saved default applies on the next call.
  - **Bluetooth OFF:** with a BT headset paired, audio does NOT auto-route to it; ON, it can.
  - **Auto-Answer ON:** an incoming call connects hands-free without tapping Answer; OFF, it rings normally.
  - **Call Waiting:** with a call active, a 2nd incoming call shows the "waiting" prompt when ON (answering ends the first), and is declined (caller → voicemail) when OFF.

---

## Self-Review

- **Spec coverage:** Audio Routing (Tasks 1-3, 6), Bluetooth (Tasks 1-2, 6), Auto-Answer (Tasks 4-6), Call Waiting (Tasks 4-6). All four Group-A device behaviors are now wired to real SDK/call-handling, not cosmetic toggles.
- **Testability:** the two decision surfaces are pure, native-free, and jest-tested (`chooseAudioDevice`, `decideInviteAction`); native audio/invite side-effects are device-verified (Task 7) since they can't be unit-tested.
- **Placeholder scan:** none — pure-logic tasks have complete code; native-wiring tasks name exact functions/files and say "read the file first" only to match the existing `Control`/`Row`/`Segmented` UI and screen structure.
- **Type consistency:** `AudioRoutePref`/`AudioDeviceLike`/`chooseAudioDevice` (Task 1) consumed by voice.ts (Task 2) + call-active (Task 3); `InviteAction`/`decideInviteAction` (Task 4) consumed by the invite handler (Task 5); pref keys `pref_audio_route`/`pref_bluetooth`/`pref_auto_answer`/`pref_call_waiting` consistent across voice.ts, the handler, and settings.

## Completes Workstream B

After Plan 4, every Settings row is functional (Plans 1-4). Remaining app-store work is Workstream C (iOS submit — incl. reviewer demo account, privacy labels, screenshots) and D (Google Play).

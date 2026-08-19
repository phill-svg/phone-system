# iOS Softphone — Phase 1: Foundation + Calling Core (Design)

Date: 2026-08-19
Status: Draft for review

## Goal

A native iPhone app that works like a real phone: it **rings for incoming calls
even when the app is backgrounded or closed**, shows the native iOS call screen,
and can place outbound calls — all tied to the existing TCB VoIP worker and Twilio
account. This is Phase 1 of a larger "fully native" mobile app; it covers the
foundation plus the calling core only.

## Non-goals (deferred to later phases)

- Native dashboard screens (Call History, Live Calls, Callback Requests, Settings,
  Staff) — **Phase 2**, separate spec. They consume existing JSON APIs.
- The IVR flow **canvas editor** — stays a desktop/web admin task; a drag canvas is
  a poor fit for a phone and is out of mobile scope entirely.
- Android — Phase 1 targets iOS. (The chosen stack keeps Android reachable later.)

## Constraints

- **Developer is Windows-only, no Mac.** Native iOS must be built in the cloud via
  **Expo EAS Build**. No local Xcode step.
- **Apple Developer account exists** ($99/yr) — certificates, VoIP push key, and
  TestFlight are available.
- **Telephony is AU1-homed** (see memory: Twilio AU1 regional account). Access
  tokens already set the `twr: "au1"` region header; the app must honour that.
- **The deployed worker is not this repo.** It is pushed straight from local and
  diverges (it has a password `/login` flow the repo's `worker.ts` lacks). Any
  server change below must land in whatever source is actually deployed — see Risks.

## Stack

- **React Native via Expo (prebuild workflow) + EAS Build** — cloud iOS builds, no Mac.
- **Twilio Voice React Native SDK** (`@twilio/voice-react-native-sdk`) — wraps the
  native iOS Voice SDK and bridges **CallKit** (native call UI) and **PushKit**
  (VoIP push). It is a native module, so the app uses an EAS dev/prod build, not
  Expo Go.
- **Custom Expo config plugin** to inject the iOS native config the SDK needs:
  - `UIBackgroundModes: [voip, audio]`
  - Push Notifications entitlement (`aps-environment`)
  - `NSMicrophoneUsageDescription`
- **Secure storage:** iOS Keychain (via `expo-secure-store`) for the session cookie.
- **Distribution:** TestFlight (internal testers).

## How it reuses the existing system

Very little is new server-side. The worker already:
- mints Twilio access tokens (`mintAccessToken`) with the staff member's `email`
  as the Voice identity and `outgoing.application_sid` = the softphone TwiML app;
- rings staff as `client:{email}` from the IVR ring logic;
- exposes presence / heartbeat / hold / transfer JSON endpoints.

The phone registers the **same `client:{email}` identity**, so incoming calls route
to it with no IVR/ring changes. Outbound reuses the existing `tcb-voip softphone`
TwiML app (`/twiml/voice-app`). Hold/transfer/presence endpoints are called as-is.

## Auth — reuse the web session cookie

1. Native login screen (email + password).
2. App POSTs to the existing `/login`, captures the returned **session cookie**.
3. Cookie stored in the **iOS Keychain**; attached to every API call and to the
   access-token request.
4. On 401, app clears the cookie and returns to the login screen.

Least server work; reuses the current password auth. **Caveat:** the deployed
`/login` source isn't in this repo, so the exact cookie name, flags
(`HttpOnly`/`Secure`/`SameSite`), and lifetime must be confirmed empirically before
the login module is finalized. If `SameSite`/CSRF or cookie flags block native use,
fall back to adding a small mobile bearer-token endpoint (recorded as the backup
auth approach; not Phase 1 default).

## Server changes

1. **APNs push credential on the access token.** For background ringing, the
   token's VoiceGrant must carry `push_credential_sid`. Add an optional
   `platform=ios` to the token endpoint (`GET /api/softphone/token`); when present,
   `mintAccessToken` includes `voice.push_credential_sid = env.TWILIO_PUSH_CREDENTIAL_SID`.
   Web callers (no `platform`) are unchanged. Keep the `twr: "au1"` header.
2. **New worker secret:** `TWILIO_PUSH_CREDENTIAL_SID` (the AU1 Twilio APNs VoIP
   push credential SID).
3. No auth-endpoint change (cookie reuse).

These changes must be applied to the **deployed** source, not just this repo (Risks).

## Native app modules (Phase 1)

- **auth** — login screen, cookie capture + Keychain storage, authenticated fetch
  wrapper, 401 handling.
- **twilioVoice** — fetch access token (`platform=ios`), register/unregister the
  device (binds APNs token + identity), receive incoming calls via CallKit, place
  outbound calls.
- **call-ui** — in-call screen: mute, hold (calls `/api/softphone/hold`),
  transfer-to-staff (`/api/softphone/transfer` + `/transfer/complete`), DTMF keypad,
  hang up. A dial screen for outbound (number entry + staff-directory dial).
- **presence** — available / away / offline (`PUT /api/softphone/presence`) and
  heartbeat (`POST /api/softphone/heartbeat`) on an interval while registered; flip
  to offline on sign-out.

## Call flows

**Incoming:** PSTN → IVR → rings `client:{email}` → Twilio sends APNs VoIP push →
iOS wakes the app → CallKit native incoming screen → on accept, audio bridges into
the conference. Works backgrounded or closed.

**Outbound:** dial screen → SDK `connect({ To })` → `tcb-voip softphone` TwiML app
(`/twiml/voice-app`) dials the target into a conference and joins the agent leg
(existing behaviour). CallKit shows the outgoing call.

## Operational setup (one-time)

1. Create a **VoIP Services key** in the Apple Developer account; generate the VoIP
   push key.
2. In Twilio (**AU1 region**), create an **APNs Push Credential** from that key;
   note its SID.
3. Set `TWILIO_PUSH_CREDENTIAL_SID` as a worker secret.
4. Configure EAS (Apple credentials, bundle id, push entitlement) and a TestFlight
   internal group.

## Testing

- **Worker (Vitest, as today):** the `platform=ios` token path — grant includes
  `push_credential_sid` when `platform=ios`, omits it otherwise; `twr:"au1"` header
  preserved.
- **Native:** CallKit incoming, PushKit background wake, outbound, mute/hold/
  transfer, presence — **physical-device manual verification** (same approach used
  for the web softphone; simulators can't do VoIP push / CallKit audio).

## Risks / open items

1. **Deployed ≠ repo (highest).** The token-endpoint change must land in the code
   that actually deploys. Before implementation: reconcile the deployed worker with
   this repo (pull the deployed source, or make the repo the deploy source). Without
   this, server changes won't take effect.
2. **Cookie behaviour of the deployed `/login`** must be confirmed for native use
   (flags, lifetime, CSRF). Backup: mobile bearer-token endpoint.
3. **Config-plugin / entitlements** are the trickiest native bit; VoIP background
   mode + push entitlement must be exactly right or background ringing silently
   fails.
4. **APNs environment mismatch** (sandbox vs production push credential) is a common
   cause of "no incoming ring" — must match the build type.

## Decomposition

- **Phase 1 (this spec):** foundation + calling core.
- **Phase 2 (later spec):** native dashboard screens over existing APIs.

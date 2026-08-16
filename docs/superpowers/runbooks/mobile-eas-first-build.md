# Mobile app: first EAS build runbook

Precondition: Phase 2 mobile tasks 1–6 (scaffold, secure token storage, API
client, auth provider, login screen, Live Calls screen + EAS config) are
merged.

This is an on-device build/verification runbook. It cannot be automated —
Phill runs these steps from a machine with the Android/iOS tooling and an
Expo account.

1. Create a free Expo account at https://expo.dev (if you don't already have
   one) and sign in on the CLI:
   `cd mobile && npx eas login`
2. Configure the EAS project (writes the project id into `mobile/app.json`):
   `npx eas build:configure`
3. **Deploy Phase 1 to prod** so the API accepts mobile login, from the repo
   root:
   `npm run deploy`
   The mobile app authenticates against the live prod API
   (`https://phone.tcbpestcontrolcanberra.com.au`) — without this deploy,
   `/api/login` won't have the auth cutover changes the app depends on.
4. Build a development client APK:
   `npx eas build --profile development --platform android`
   This uses `mobile/eas.json`'s `development` profile
   (`developmentClient: true`, `distribution: internal`).
5. Install the APK on the Android test phone (EAS gives a download link/QR
   code when the build finishes).
6. Open the app, log in with the TCB staff credentials, and confirm the Live
   Calls screen shows real in-progress calls. Place a test call to the main
   number to see a call appear (it polls every 5 seconds).
7. Confirm sign-out works (header "Sign out" link returns to the login
   screen) and that re-opening the app after sign-in restores the session
   without re-prompting for credentials.

## iOS

`npx eas build --profile development --platform ios` builds the same
development client for iOS. A free Apple ID is enough to install a 7-day
development build on a personal test device (register the device UDID with
EAS/Apple when prompted during the build — a paid Apple Developer account is
only needed for TestFlight/App Store distribution, not for this).

## Rollback / troubleshooting

- Login fails with a network error: confirm step 3 (Phase 1 deploy) actually
  ran and `https://phone.tcbpestcontrolcanberra.com.au/api/login` is live —
  check with `curl` or a browser.
- Login succeeds but Live Calls never populates: confirm a call is actually
  in progress (the endpoint only returns calls with an active status), and
  check the Worker logs (`npx wrangler tail`) for `/api/calls/live` requests
  from the device.
- App drops back to the login screen unexpectedly: this is the app's global
  401 handler — it means the stored token was rejected by the API (expired,
  revoked, or the API was redeployed with a different session secret).

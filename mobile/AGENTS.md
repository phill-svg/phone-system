# Expo HAS CHANGED

This app is pinned to **Expo SDK 54**. Do NOT upgrade it without a plan, and read the
exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

**The original reason for the pin no longer holds, and the pin is not therefore optional.**
It was: Expo Go on the App Store serves SDK 54 only, and Phill tested on a real iPhone
through Expo Go with no paid Apple Developer account. As of 2026-09-11 there is a paid
account (Team ID B7WRQ9STH6), a signed TestFlight build (build 5) and internal testers, so
Expo Go is no longer how this app is run. The root `CLAUDE.md` has flagged that rationale
stale since then; this file said otherwise until 2026-09-21.

What keeps the pin now is the cost of moving, not Expo Go:
- The CallKit fix lives in generated native code — `mobile/plugins/withTwilioEarlyInit.js`
  appends `TwilioEarlyInit.swift` to `AppDelegate.swift` and hands the Twilio module back
  through `extraModulesForBridge:`. Nothing local compiles it: `npm test`, `tsc` and
  prebuild all pass over it, and only an EAS build proves it. An SDK bump moves the
  anchors that plugin patches and re-opens the one bug that caused the missed calls
  (`0xBAADCA11`), which cannot be caught without a device.
- `newArchEnabled` is on and reanimated 4 requires it, so there is no falling back to the
  old architecture if the bridgeless behaviour changes.
- A native build is the only way to ship the result: an OTA cannot carry an SDK upgrade, so
  a bad one is a TestFlight round trip, not a rollback.

One thing the upgrade WOULD unlock, established 2026-09-10: **Expo Observe needs SDK 55+**.
It measures startup performance, not crashes, so it would not have caught `0xBAADCA11`
either. Treat the upgrade as real work with real risk, not a version bump.

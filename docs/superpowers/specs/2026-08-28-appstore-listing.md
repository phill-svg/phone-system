# App Store Connect Listing + Review Notes — TCB Phone (iOS)

Draft content to paste into App Store Connect once the TestFlight build lands. Everything here is
ready to use; adjust wording to taste.

> **Distribution decided 2026-09-03: UNLISTED, not a public listing.** See the section below. This
> changes the review framing — read it before pasting the review notes.

**App:** TCB Phone · **Bundle ID:** `au.com.tcbpestcontrolcanberra.tcbphone` · **Version:** 1.0.0
**Category:** Business (primary) · Productivity (secondary)
**Support URL:** https://tcbvoip.app · **Marketing URL:** https://tcbvoip.app
**Privacy Policy URL:** https://tcbvoip.app/privacy

---

## App name (30 char max)
`TCB Phone`

## Subtitle (30 char max)
`Business calls & messages`

## Promotional text (170 char, updatable anytime)
`The TCB Pest Control staff phone — take business calls, SMS, and Facebook messages from one place, wherever you are.`

## Description
```
TCB Phone is the internal business phone for TCB Pest Control Canberra staff. It puts the
company's phone line and message inboxes on your device so you can serve customers from anywhere.

• Make and receive business calls on the company number
• Send and receive SMS with customers
• See Facebook Messenger conversations alongside SMS in one inbox
• Caller ID matched to your saved contacts
• Voicemail with automatic text transcription
• Call history, missed-call and voicemail notifications
• Choose your audio route (earpiece, speaker, Bluetooth), auto-answer, and "ring my mobile"

TCB Phone is a private, staff-only tool. Accounts are created and managed by TCB Pest Control
Canberra — it is not available for public sign-up.
```

## Keywords (100 char, comma-separated, no spaces)
`business phone,voip,pest control,staff,calls,sms,messenger,team,softphone,work`

## What's New (version 1.0.0)
```
First release of TCB Phone: business calling, SMS, Facebook Messenger inbox, voicemail
transcription, and call notifications for TCB Pest Control staff.
```

---

## Distribution: unlisted (decided 2026-09-03)

**The app ships as an [unlisted app](https://developer.apple.com/support/unlisted-app-distribution),
not a public App Store listing.** An unlisted app is on the real App Store but invisible to search,
charts, categories and recommendations. You get a normal App Store link.

**Why this and not the alternatives:**

| Route | Verdict |
| --- | --- |
| Public listing | Guideline 3.2 — a single business's staff tool doesn't belong in public listings. External TestFlight was already rejected under 2.2 for the same underlying reason. |
| TestFlight internal | Works, no review, but builds **expire after 90 days** and every tester needs an Apple ID on the App Store Connect team. Churn forever. |
| Apple Business Manager custom app | Requires a **Company/Organization** developer account with a D-U-N-S. This enrollment is **individual** (Team ID B7WRQ9STH6), so it's closed without converting the account. |
| **Unlisted** | **Chosen.** Direct link, staff install with their own Apple ID, auto-updates like any App Store app, no expiry, no ABM, no MDM, no per-tester admin. One review pass, then done. |

**How staff install it:** you send them the App Store link. They tap it and install. That's all —
no redemption codes, no device present, no profiles.

**How to get it:** submit the app to App Review with complete metadata *and a Review Notes line
saying it's intended for unlisted distribution*, then file the
[unlisted app request form](https://developer.apple.com/contact/request/unlisted-app/). Apple
declines requests for apps that haven't been submitted for review or are still in a beta state.

**Apple's own warning:** anyone with the link can install it. That's fine here — the app requires a
staff login, and accounts are provisioned by the business.

---

## App Review Information (CRITICAL — this is what prevents rejection)

**Sign-in required:** YES — provide a demo account.

**Demo account (CREATED + login-verified 2026-08-28 against tcbvoip.app):**
- Username (email): `reviewer@tcbpestcontrolcanberra.com.au`
- Password: `TcbReview2026!`
- Role: staff. Verified: `POST /api/login` returns a token. Delete this account after review if desired.

**Review notes (paste into "Notes").**

> **Superseded 2026-09-03.** The advice below used to be "never say staff-only, it hands the
> reviewer Guideline 3.2 in writing." That was right for a *public* listing. Going unlisted
> reverses it: the limited audience is the whole reason unlisted distribution exists, and Apple
> asks you to state the intent in the review notes. Say it plainly. Do not "fix" this back to the
> evasive framing.

Describe what the app does, how accounts are issued, and that it is bound for unlisted
distribution.

```
TCB Phone is a business phone app for small service businesses. It turns a company's business
number into a softphone: staff make and take calls on the business line, send and receive SMS, and
handle Facebook Messenger enquiries from one inbox. Accounts are provisioned by the subscribing
business rather than created in the app, so please sign in with the demo account above.

Calling: the app is a softphone for the business's telephone number (via Twilio). Incoming calls
are delivered as VoIP pushes and presented through the system call UI; outbound calls and SMS are
placed from the business number. To test messaging, open the Messages tab (sample conversations may
be present under the demo account).

The app requests microphone access to place/receive calls and notification permission to alert
staff to incoming calls, missed calls, voicemail, and messages.

This app is intended for UNLISTED distribution. It is used by the staff of a single business, so a
public App Store listing is not appropriate for it; we have filed a request for unlisted app
distribution and would like this version approved on that basis.

Contact: phill@tcbpestcontrolcanberra.com.au
```

**Contact info:** Phill Johnston · phill@tcbpestcontrolcanberra.com.au · (phone number)

---

## App Privacy (Data collection questionnaire) — answers to declare
Declare "Data linked to you" for the account + usage. Suggested declarations:
- **Contact Info:** Email address, Phone number — *App functionality, linked to identity.*
- **User Content:** Messages/other (SMS + Messenger content, call recordings/voicemail) —
  *App functionality, linked to identity.*
- **Identifiers:** User ID (staff account); device push token — *App functionality.*
- **Usage/Diagnostics:** only if you actually collect analytics/crash data (you currently don't →
  declare none unless added).
- **Not used for tracking; not shared with third parties for advertising.** (Processors: Twilio,
  Cloudflare, Apple/Google push — these are service providers, not "sharing" in the ATT sense.)
- Matches the Privacy Policy at /privacy.

---

## Screenshots (required — one 6.9" set, that's all)

Apple dropped the per-size requirements: supply **6.9" iPhone only** and it scales that down to
every smaller device. A 13" iPad set is required only if the app supports iPad, and this one does
not (`mobile/app.json` sets no `ios.supportsTablet`).

**Required size: 1320×2868 portrait. 3–10 screenshots.** App Store Connect validates the pixel
dimensions exactly — a "roughly right" resize is rejected.

**Take them on the iPhone 16 Pro Max.** It *is* a 6.9" device: its native screenshot is 1320×2868,
so Side button + Volume Up gives a pixel-perfect asset with no resizing, no simulator, and no Mac.
Upload them through App Store Connect in a browser.

Shot list:
1. Keypad / dialer
2. Active call screen
3. Messages inbox (showing SMS + a Facebook Messenger conversation with the badge)
4. A message thread
5. Recents / call history
6. Settings (showing the functional rows)

Avoid real customer names and numbers in the captures — App Review reads these, and it saves a
privacy question that is tedious to answer after the fact.

---

## Pre-submit checklist
- [ ] Build on TestFlight, processed, and selected for the version
- [ ] Demo account created + works via /api/login, entered in Review Information
- [ ] Review notes pasted, **including the unlisted-distribution line**
- [ ] App Privacy questionnaire completed (matches /privacy)
- [ ] Screenshots uploaded — 1320×2868, taken on the iPhone 16 Pro Max
- [ ] Support URL, Privacy Policy URL set
- [ ] Age rating questionnaire completed (likely 4+)
- [ ] Export compliance: uses only standard encryption → `ITSAppUsesNonExemptEncryption=false` (already set)
- [x] **Production VoIP push — done.** The Twilio credential `CRcb31d1c3e79de7195d6c81eb241ebc75`
      has `Sandbox=false` and `app.json` sets `aps-environment: production`. Calling and incoming
      push were confirmed working on-device on iOS (2026-08-27, re-confirmed 2026-09-03). Do not
      create a second credential; the earlier "make a separate production one" note is stale.
- [ ] **After submitting:** file the
      [unlisted app request form](https://developer.apple.com/contact/request/unlisted-app/)

## Known review risks (be ready)
1. **Guideline 3.2 / "why is a one-business staff tool on the App Store":** no longer a risk to
   dodge — it is the reason for the unlisted request, and the review note says so outright.
2. **VoIP / CallKit:** apps using the `voip` background mode are expected to present incoming calls
   via CallKit. The Twilio Voice RN SDK integration does this and calling is confirmed working
   on-device on iOS.
3. **Demo account must actually work** — the #1 avoidable rejection. Re-verify
   `reviewer@tcbpestcontrolcanberra.com.au` right before submitting. Note it currently sits in the
   live ring roster marked `available`; only a stale heartbeat keeps it from ringing on real calls.

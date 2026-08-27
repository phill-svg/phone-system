# App Store Connect Listing + Review Notes — TCB Phone (iOS)

Draft content to paste into App Store Connect once the TestFlight build lands. Everything here is
ready to use; adjust wording to taste.

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

## App Review Information (CRITICAL — this is what prevents rejection)

**Sign-in required:** YES — provide a demo account.

**Demo account (CREATED + login-verified 2026-08-28 against tcbvoip.app):**
- Username (email): `reviewer@tcbpestcontrolcanberra.com.au`
- Password: `TcbReview2026!`
- Role: staff. Verified: `POST /api/login` returns a token. Delete this account after review if desired.

**Review notes (paste into "Notes"):**
```
TCB Phone is a private, staff-only business phone app for TCB Pest Control Canberra. There is no
public sign-up by design — accounts are provisioned by the business. Please use the demo account
provided above to sign in.

Calling: the app is a softphone for the business's telephone number (via Twilio). Incoming calls
are delivered as VoIP pushes and presented through the system call UI; outbound calls and SMS are
placed from the business number. To test messaging, open the Messages tab (sample conversations may
be present under the demo account).

The app requests microphone access to place/receive calls and notification permission to alert
staff to incoming calls, missed calls, voicemail, and messages.

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

## Screenshots (required — 6.7" iPhone at minimum; add 6.5" if easy)
Capture from the app on a device/simulator (I can drive these once the build's installable):
1. Keypad / dialer
2. Active call screen
3. Messages inbox (showing SMS + a Facebook Messenger conversation with the badge)
4. A message thread
5. Recents / call history
6. Settings (showing the functional rows)

Required size: 1290×2796 (6.7"). 3–10 screenshots.

---

## Pre-submit checklist
- [ ] Build on TestFlight, processed, and selected for the version
- [ ] Demo account created + works via /api/login, entered in Review Information
- [ ] Review notes pasted
- [ ] App Privacy questionnaire completed (matches /privacy)
- [ ] Screenshots uploaded (6.7")
- [ ] Support URL, Privacy Policy URL set
- [ ] Age rating questionnaire completed (likely 4+)
- [ ] Export compliance: uses only standard encryption → `ITSAppUsesNonExemptEncryption=false` (already set)
- [ ] Production Twilio VoIP push cert (so incoming calls ring on the store build — see note in
      the App Store readiness memory)

## Known review risks (be ready)
1. **Guideline 4.2 / "why public if staff-only":** the review note frames it as an internal business
   tool; the demo account lets them see it works. If Apple pushes back, the alternative is
   **unlisted app distribution** (App Store Connect → Pricing → unlisted) or Apple Business Manager
   custom app — same build, not publicly discoverable.
2. **VoIP / CallKit:** apps using the `voip` background mode are expected to present incoming calls
   via CallKit. Confirm the incoming-call path does so (Twilio Voice RN SDK CallKit integration).
3. **Demo account must actually work** — the #1 avoidable rejection.

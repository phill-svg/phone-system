# Runbook: ship TCB Phone privately via Apple Business Manager (custom app)

Apple rejected the TestFlight external-testing submission under **Guideline 2.2 — Beta Testing**:
TestFlight is meant for beta-testing apps that are *heading for public distribution*, and TCB Phone
is a staff-only tool with no public sign-up. The rejection itself names the fix — **Apple Business
Manager**. This runbook is that path, end to end.

Listing copy, demo credentials and review notes live in `../specs/2026-08-28-appstore-listing.md`
and are still required: a custom app is **still reviewed by App Review**.

Like the other store runbooks this **cannot be run from CI here** — it needs a browser signed in to
Apple Business Manager and App Store Connect, plus an `eas` login for the build.

---

## What Apple Business Manager is

Apple Business Manager (ABM, `business.apple.com`) is a free web portal a company enrols in to
manage its Apple side of things: company-owned devices, Managed Apple Accounts, volume app
purchasing, and — the part we want — **custom apps**.

A custom app is a normal App Store app with one difference: instead of being listed publicly, its
availability is restricted to organisations you name by their **Organization ID**. It is built,
signed, uploaded and reviewed exactly like a public app; it just never appears in search, charts or
categories, and only TCB's ABM account can get it.

For us the developer and the organisation are the same company: TCB Pest Control Canberra enrols in
ABM, and the App Store Connect record points the app at TCB's own Organization ID.

Staff install it either through an MDM (we have none) or through **redemption codes** — a
spreadsheet of one-time codes redeemed in the App Store app. No MDM, no device enrolment, no UDIDs,
no 90-day expiry. That is the route below.

---

## Read this before touching anything

**The distribution method is locked once the app is approved, and cannot be flipped later**
(public → private or private → public). Changing it after approval means a *new app record*, which
means a *new bundle identifier* — bundle IDs cannot be reused across records.

App `6806023125` (`au.com.tcbpestcontrolcanberra.tcbphone`) has **never been approved** — the only
submission was the rejected TestFlight beta review — so the switch to Private should still be
available on the existing record. Do step 2 **before** submitting anything else for review.

If App Store Connect will not offer Private on that record, fall back to a new record with a new
bundle ID (e.g. `au.com.tcbpestcontrolcanberra.tcbphone.custom`); `mobile/app.config.js` already has
the variant pattern to do that from an env var. That also means a new `ascAppId` in
`mobile/eas.json` and a new push credential, so avoid it if at all possible.

---

## How this interacts with the multi-tenant roadmap

`../specs/2026-08-31-tenancy-foundation-design.md` lists sub-project **7 — App Store submission
under the public story**, gated on sub-projects 2–5 (sign-up, provisioning, billing, ServiceM8).
That is the point at which a *public* App Store listing becomes legitimate: once anyone can
register and pay, the app is a general-audience product rather than one company's staff tool, and
the Guideline 3.2 objection disappears on its own.

That matters here because **the custom-app choice is one-way on a given app record**. Setting
`au.com.tcbpestcontrolcanberra.tcbphone` to Private means that record can never be flipped to
public for the tenanted launch.

So decide this before starting step 0:

- **If the public product will be a new, differently-branded app** (likely — the roadmap describes
  "the ServiceM8-native phone system for Australian trades", which is not "TCB Phone", and the
  bundle ID is TCB's own reverse domain), then the two never collide. Take TCB Phone private as a
  custom app and let the public product get its own record and identifier when sub-projects 2–5
  land. **This is the expected path.**
- **If "TCB Phone" on this bundle ID is meant to become the public product**, do *not* set it to
  Private. Bridge staff on internal TestFlight instead and keep the record clean for the public
  submission, because a custom app cannot be converted back.

## Getting the app onto staff phones *right now*

Independent of the above, and available today: **internal TestFlight testers skip Beta App Review
entirely**. App Store Connect → *Users and Access* → add each staff member as a user, then add them
to an **Internal Testing** group in TestFlight. Builds reach them within minutes of processing, with
no review and no ABM.

The catch is that TestFlight builds expire **90 days** after upload, so this needs a re-upload each
quarter. It is a bridge, not a destination — but it is the right bridge while ABM enrolment is being
verified, or while sub-projects 2–5 are in flight.

---

## 0. One-time: enrol TCB in Apple Business Manager

Free, but Apple verifies the organisation by phone, so start this first — it is the long pole
(typically several business days).

1. Go to `business.apple.com` → **Enroll now**.
2. Provide:
   - Organisation legal name and address (must match the Apple Developer org).
   - **D-U-N-S number** — the same one used for the Apple Developer Program enrolment. Look it up at
     `developer.apple.com/enroll/duns-lookup`. (Apple has begun accepting other business-ID forms in
     some countries; Australia still asks for D-U-N-S.)
   - The work email + name of the person who will be the **Administrator** (Phill). Use a
     `@tcbpestcontrolcanberra.com.au` address, not a personal Apple Account, and not an address
     already tied to an existing Managed Apple Account.
   - A **verification contact** — a second person Apple can phone who can confirm the administrator
     and accept the terms on the company's behalf. Apple *will* call them; a contact who does not
     answer is the usual reason enrolment stalls.
3. Wait for approval, then sign in and accept the ABM terms.
4. In ABM, accept the **Apps and Books** terms as well. Nothing to pay: TCB Phone stays **Free
   ($0)**, so no payment method and no Paid Apps agreement are needed.

## 1. Get the Organization ID

In ABM: click the organisation name (bottom-left) → **Preferences** → **Enrollment Information** →
copy **Organization ID**. It is a numeric ID, distinct from the D-U-N-S number and from the Apple
Developer Team ID.

## 2. Point the App Store Connect record at it

App Store Connect → **Apps** → TCB Phone → **Pricing and Availability**. Requires Account Holder,
Admin or App Manager.

1. Price: **Free**.
2. Under **App Distribution Methods**, select **Private**.
3. Type: **Organization ID**. Enter TCB's Organization ID and organisation name.
4. **Save** (top right).

Confirm the page now shows Private/custom-app distribution before moving on.

## 3. Build and submit — unchanged

Nothing about the build changes. From `mobile/`:

```bash
npx eas login                                        # skip if already signed in
npx eas build --profile production --platform ios    # autoIncrement bumps the build number
npx eas submit --profile production --platform ios   # uses ascAppId 6806023125 + the ASC API key
```

`submit.production.ios` in `eas.json` already carries the App Store Connect API key path and issuer.
The binary lands in App Store Connect exactly as before — "custom app" is purely the availability
setting from step 2.

## 4. Submit for review

Attach the build to version 1.0.0 and fill in everything from
`../specs/2026-08-28-appstore-listing.md`. Custom apps go through App Review, so the parts that
matter most:

- **Demo account** — `reviewer@tcbpestcontrolcanberra.com.au` in App Review Information. Verify it
  still logs in against `tcbvoip.app` on the day of submission; a dead demo account is the single
  most common rejection.
- **Review notes** — keep the "private, staff-only, accounts provisioned by the business" framing.
  Under custom-app distribution that is now the *point* of the submission rather than a risk.
- Screenshots, age rating, privacy questionnaire, export compliance — all still required.

Expect one to three days.

## 5. Buy the licences in ABM

Once approved, the app appears **only** in TCB's ABM account.

1. ABM → **Apps and Books** (custom apps appear under Custom Apps / by searching the app name).
   You need Administrator or Content Manager to buy.
2. Select TCB Phone → set **License Type** to **Redemption Codes** (the alternative, *Managed
   Distribution*, is the MDM route — ignore it, we have no MDM).
3. Quantity: one per staff device, plus spares. Free, so the "purchase" is $0. Cap is 10,000 codes
   per request.
4. Apple emails a confirmation; download the resulting spreadsheet of one-time codes.

## 6. Install on staff devices

Send each staff member one code. On the device: **App Store → profile picture → Redeem Gift Card or
Code → enter the code**. The app downloads and installs like any other App Store app — no TestFlight,
no expiry, no device registration.

Codes are single-use, **cannot be revoked once redeemed**, and only work in the App Store country of
the ABM account (Australia). Track which code went to whom in the spreadsheet.

## 7. Shipping updates afterwards

- **JS-only changes** still go over the air: the installed app stays on the `production` EAS Update
  channel, so `eas update --branch production` reaches staff without App Review, exactly as today.
- **Native changes / version bumps** go through steps 3–4 again. Existing installs update from the
  App Store automatically; **no new redemption codes are needed** for an update — codes are only for
  the first install on a new device or person.

---

## Alternatives, and why not

| Route | Verdict |
|---|---|
| **Custom app via ABM** | Chosen. What Apple's rejection recommends, no MDM required, permanent installs, OTA updates keep working. Cost: ABM enrolment wait. |
| **Unlisted app distribution** | Viable fallback. App is on the public App Store but hidden from search/charts and installed by direct link — no ABM, no codes. But it must first be approved as a *public* app, and requires a separate request to Apple (`developer.apple.com/contact/request/unlisted-app`, ~5–7 business days). A staff-only app with no public sign-up is exactly what gets bounced under Guideline 4.2/3.2 in a public review, so this trades one review risk for another. |
| **TestFlight internal testers** | Stopgap only. Internal testers (up to 100) must be App Store Connect users under *Users and Access*, and their builds skip Beta App Review entirely — so staff can keep running the app today while ABM enrolment goes through. Builds still expire after 90 days, and Apple has now explicitly flagged this app's use of TestFlight, so do not treat it as the destination. |
| **Apple Developer Enterprise Program** | No. $299/yr, strict eligibility (Apple expects 100+ employees and a real internal-distribution case), and applications from small companies are routinely refused. |
| **Ad hoc (`distribution: internal` in `eas.json`)** | Fine for our own testing, not for staff rollout: max 100 devices, every UDID registered by hand, and profiles expire every 12 months. |

---

## Troubleshooting

- **ABM enrolment stuck "pending"** → Apple could not reach the verification contact. Check the
  contact's phone/voicemail and that the D-U-N-S record's company details match what was entered.
- **App Store Connect shows no Private option** → the record has already been approved with a
  distribution method, or the signed-in user lacks App Manager. If it is genuinely locked, a new app
  record with a new bundle ID is the only route (see the warning above).
- **App does not appear in ABM after approval** → the Organization ID in App Store Connect is wrong
  (D-U-N-S or Team ID pasted by mistake), or ABM's Apps and Books terms were never accepted.
- **Redemption code says "not available in this country"** → the device's App Store account is set to
  a country other than Australia. Codes are country-locked to the ABM account's region.
- **Staff on the old TestFlight build stop receiving calls** → TestFlight builds expire 90 days after
  upload. Move them onto the ABM install; the redeemed App Store build does not expire.
- **Incoming calls do not ring on the store build but work in dev** → unrelated to distribution;
  check the production Twilio VoIP push credential on the deployed Worker, per the App Store
  readiness notes.

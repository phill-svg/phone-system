import { escapeHtml } from "../layout";

// Public (no-auth) legal pages linked from the mobile app's Settings and required for the
// App Store / Play Store listings. Reader-oriented shell (wider than the login card) that matches
// the app's dark brand styling.
function legalShell(title: string, updated: string, sections: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — TCB Phone</title>
<style>
  :root { --bg:#0f1013; --surface:#1b1d24; --border:#26282f; --text:#eceef2; --dim:#a7adb8; --mute:#6d7280; --brand:#e4002b; --link:#ff5c78; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  .brand { display: flex; align-items: center; gap: 0.55rem; margin-bottom: 1.75rem; }
  .brand .mark { width: 36px; height: 36px; border-radius: 8px; background: #fff; padding: 4px; object-fit: contain; }
  .brand .word { font-weight: 700; font-size: 0.9rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.35rem; }
  .updated { color: var(--mute); font-size: 0.8rem; margin: 0 0 2rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }
  p, li { color: var(--dim); font-size: 0.92rem; }
  a { color: var(--link); }
  ul { padding-left: 1.2rem; }
  li { margin-bottom: 0.3rem; }
  .foot { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--mute); font-size: 0.8rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><img class="mark" src="/logo.png" alt="TCB"><div class="word">TCB Phone</div></div>
  <h1>${escapeHtml(title)}</h1>
  <p class="updated">Last updated ${escapeHtml(updated)}</p>
  ${sections}
  <div class="foot">TCB Pest Control Canberra · Questions? <a href="mailto:phill@tcbpestcontrolcanberra.com.au">phill@tcbpestcontrolcanberra.com.au</a></div>
</div>
</body>
</html>`;
}

const LAST_UPDATED = "27 August 2026";

export function renderPrivacyPolicyPage(): string {
  return legalShell(
    "Privacy Policy",
    LAST_UPDATED,
    `<p>TCB Phone is a private business phone and messaging application operated by TCB Pest Control Canberra
      for use by its authorised staff. This policy explains what information the app handles and why.</p>

    <h2>Who this app is for</h2>
    <p>TCB Phone is an internal, staff-only tool. Accounts are created and managed by TCB Pest Control Canberra;
      it is not available for public sign-up.</p>

    <h2>Information we handle</h2>
    <ul>
      <li><strong>Account details</strong> — your name, email address and role, used to sign you in and control access.</li>
      <li><strong>Calls and messages</strong> — phone numbers, timestamps, call duration and status, message content,
        and (where enabled) call recordings and voicemail, along with automated transcriptions of recordings and voicemail.</li>
      <li><strong>Contacts</strong> — customer and contact details saved in the system so calls and messages can be
        matched to a name.</li>
      <li><strong>Device information</strong> — a push-notification token for your device, so we can alert you to
        incoming calls and messages.</li>
    </ul>

    <h2>How we use it</h2>
    <ul>
      <li>To place and receive calls and text messages on behalf of the business.</li>
      <li>To show call history, voicemail and message threads, and to notify you of activity.</li>
      <li>To transcribe voicemail and recorded calls so they can be read as text.</li>
      <li>To keep the service secure and operating correctly.</li>
    </ul>

    <h2>Service providers</h2>
    <p>To deliver the service we rely on a small number of trusted providers who process data on our behalf:</p>
    <ul>
      <li><strong>Twilio</strong> — carries the calls and SMS messages.</li>
      <li><strong>Cloudflare</strong> — hosts the application, database and recording storage.</li>
      <li><strong>Apple Push Notification service and Google Firebase</strong> — deliver notifications to your device.</li>
    </ul>
    <p>We do not sell your information or share it for advertising.</p>

    <h2>Retention and security</h2>
    <p>Call, message and recording data is retained only for as long as it is useful for running the business phone
      service, and access is limited to authorised staff. Access to the app requires a personal login.</p>

    <h2>Your choices</h2>
    <p>Because accounts are managed by the business, requests to access, correct or delete your information should be
      directed to the contact below.</p>

    <h2>Changes</h2>
    <p>We may update this policy from time to time. The "last updated" date above reflects the current version.</p>`
  );
}

export function renderTermsOfServicePage(): string {
  return legalShell(
    "Terms of Service",
    LAST_UPDATED,
    `<p>These terms govern use of TCB Phone, the internal phone and messaging application provided by
      TCB Pest Control Canberra ("we", "us"). By using the app you agree to these terms.</p>

    <h2>Authorised use</h2>
    <p>TCB Phone is provided for authorised staff of TCB Pest Control Canberra for business purposes only. You must
      keep your login credentials confidential and are responsible for activity under your account.</p>

    <h2>Acceptable use</h2>
    <ul>
      <li>Use the app only for legitimate business communications.</li>
      <li>Do not use it for unlawful, harassing, or abusive purposes, or to send unsolicited bulk messages.</li>
      <li>Do not attempt to access data or accounts that are not yours, or to disrupt the service.</li>
    </ul>

    <h2>Calls and recordings</h2>
    <p>Where call recording is enabled, you are responsible for handling recordings and for meeting any legal
      requirements to notify or obtain consent from the other party.</p>

    <h2>Availability</h2>
    <p>The app depends on third-party networks and services (including telephony and internet providers) and is
      provided on an "as is" and "as available" basis, without warranties of any kind. We are not liable for
      interruptions, missed calls or messages, or loss of data to the extent permitted by law.</p>

    <h2>Access changes</h2>
    <p>We may suspend or remove access at any time, for example when a staff member leaves the business.</p>

    <h2>Changes to these terms</h2>
    <p>We may update these terms from time to time. Continued use of the app after an update means you accept the
      revised terms.</p>`
  );
}

// Linked as the App Store / Play Store "Support URL". It must be reachable WITHOUT a login: the
// site root redirects to /admin/live, which bounces a logged-out visitor to /login, and a reviewer
// meeting a login wall where support information should be is an avoidable rejection.
export function renderSupportPage(): string {
  return legalShell(
    "Support",
    LAST_UPDATED,
    `<p>TCB Phone is the internal phone and messaging app for staff of TCB Pest Control Canberra. This
      page is for help with the app itself.</p>

    <h2>Contact us</h2>
    <ul>
      <li>Email: <a href="mailto:phill@tcbpestcontrolcanberra.com.au">phill@tcbpestcontrolcanberra.com.au</a></li>
      <li>Phone: <a href="tel:+61261059771">(02) 6105 9771</a></li>
      <li>Hours: Monday to Friday, 8am - 5pm (Australian Eastern Time). We aim to reply within one business day.</li>
    </ul>

    <h2>Getting an account</h2>
    <p>Accounts are created and managed by TCB Pest Control Canberra; there is no public sign-up. If you are a
      staff member without access, contact us at the address above and we will send you an invitation.</p>

    <h2>Signing in</h2>
    <p>Sign in with your work email address and the password you set from your invitation link. If you have
      forgotten it, use "Forgot password" on the sign-in screen and a reset link will be emailed to you.</p>

    <h2>Common questions</h2>
    <ul>
      <li><strong>Calls are not ringing.</strong> Check that Settings shows "Incoming calls: registered" and that
        notifications are allowed for TCB Phone in your device settings. If "Ring My Mobile" is on, calls go to
        your mobile number instead of the app, by design.</li>
      <li><strong>No microphone during a call.</strong> Allow microphone access for TCB Phone in your device
        settings; the app cannot place or take calls without it.</li>
      <li><strong>Messages are missing.</strong> Pull down on the Messages list to refresh. SMS and Facebook
        Messenger conversations both appear there.</li>
    </ul>

    <h2>Privacy and terms</h2>
    <p>See our <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.</p>`
  );
}

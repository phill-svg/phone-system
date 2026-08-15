# TCB email + password authentication — design

**Date:** 2026-08-15
**Status:** Approved (brainstorm), pending implementation plan
**Author:** Phill + Claude

## Goal

Replace the Cloudflare Access login (the "Cloudflare-branded" sign-in page users
currently hit) with a **TCB-branded email + password sign-in** served by the
Worker itself. Staff are invited by email and set their own password; sessions
are tracked server-side so access can be revoked instantly.

## Background / current state

- The app is a single Cloudflare Worker (`src/worker.ts`) backed by D1 (`DB`).
- Auth today is external: **Cloudflare Access** guards `/admin/*` and `/api/*`.
  The Worker trusts the `Cf-Access-Jwt-Assertion` header and verifies it in
  `src/access/requireStaffUser.ts` (with an `AUTH_MODE=dev` bypass using
  `DEV_STAFF_EMAIL` for local development).
- `staff_users` (migration `0003`) is keyed by `email` with a `role`
  (`admin` | `staff`) and various softphone columns. **No password column.**
- `/webhooks/*` and `/media/*` are intentionally public (Twilio-signature auth of
  their own) and are NOT behind Access. They must remain reachable and unchanged.
- Established brand: dark UI (`--admin-bg #0f1013`, surface `#1b1d24`), red brand
  `#e4002b`→`#c10023`, "TCB VoIP" wordmark (`src/html/layout.ts`).

## Prerequisite (operational, not code)

Cloudflare Access must be **disabled for this app's hostname** in the Cloudflare
Zero Trust dashboard. Until it is, CF's page still sits in front of ours and the
branded login is unreachable. Phill does this in the dashboard. The public
webhook/media routes are unaffected (they were already excluded from Access).

## Chosen approach

- **Custom auth in the Worker** (not Cloudflare Access re-skin).
- **Server-side sessions in D1** (not stateless signed cookie) — chosen for
  instant revocation (logout / disable staff / leaked cookie) in a system that
  can place real PSTN calls. Cost is one extra D1 read per gated request, which
  is negligible against existing per-request D1 usage.
- **Invite + reset via email** using **Twilio SendGrid**.

## Data model (new migrations)

Migration `0014_auth_passwords.sql`:

```sql
ALTER TABLE staff_users ADD COLUMN password_hash TEXT;      -- NULL = invited, not yet set
ALTER TABLE staff_users ADD COLUMN password_set_at INTEGER; -- ms epoch, NULL until set

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,     -- SHA-256 of the opaque cookie token (never store raw)
  email      TEXT NOT NULL REFERENCES staff_users(email),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_email ON sessions(email);

CREATE TABLE password_tokens (
  token_hash TEXT PRIMARY KEY,     -- SHA-256 of the one-time token in the email link
  email      TEXT NOT NULL REFERENCES staff_users(email),
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER                -- NULL until consumed; single-use
);
CREATE INDEX idx_password_tokens_email ON password_tokens(email);
```

Notes:
- We only ever store **hashes** of session tokens and email-link tokens. The raw
  token lives only in the cookie / the emailed URL.
- Existing admin row (`phill@…`) has a null password until Phill sets one — Phill
  can use the "forgot password" flow to bootstrap, or a one-off seeded invite.

## Password hashing

- **PBKDF2-HMAC-SHA256** via WebCrypto (`crypto.subtle`) — the only strong KDF
  available natively in Workers. ~210,000 iterations, 16-byte random per-user
  salt, 32-byte derived key.
- Stored format: `pbkdf2$<iterations>$<saltB64>$<hashB64>`.
- Verification is constant-time (compare derived bytes, not strings).
- New file: `src/access/password.ts` — `hashPassword(plain)`,
  `verifyPassword(plain, stored)`.

## Sessions

- New file: `src/access/session.ts`.
- On login: generate 32 random bytes → base64url = raw token. Store
  `SHA-256(token)` in `sessions` with `expires_at = now + 12h`. Set cookie:
  `tcb_session=<raw>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`.
- Lookup: hash the cookie value, select the row, reject if missing/expired.
  Sliding refresh is out of scope for v1 (fixed 12h; user re-logs in).
- Logout: delete the session row, clear the cookie.
- Best-effort cleanup of expired rows on login (cheap `DELETE ... WHERE expires_at < ?`).

## Tokens (invite / reset)

- New file: `src/access/tokens.ts`.
- Generate 32 random bytes → base64url. Store `SHA-256(token)` in
  `password_tokens`. Email a link: `https://<host>/set-password?token=<raw>`.
- Lifetimes: **invite 7 days**, **reset 1 hour**. Single-use (`used_at`).
- Consuming a token: validate (exists, right purpose, not used, not expired),
  set the password, mark `used_at`, and (defense in depth) invalidate the user's
  existing sessions on a reset.

## Email (SendGrid)

- New file: `src/email/sendgrid.ts` — thin `sendEmail({to, subject, html})` over
  `POST https://api.sendgrid.com/v3/mail/send`.
- New Worker secrets: `SENDGRID_API_KEY`, and a var `AUTH_FROM_EMAIL`
  (e.g. `no-reply@tcbpestcontrolcanberra.com.au`, a verified SendGrid sender).
- Two templates: **invite** ("You've been added to TCB VoIP — set your
  password") and **reset** ("Reset your TCB VoIP password"). Plain, branded HTML.
- Failures are surfaced to the admin on invite; the forgot-password endpoint
  always returns the same neutral response regardless (no account enumeration).

## Routes (new / changed in `src/worker.ts`)

Public (no session required), added before the `/admin` and `/api` gates:

- `GET  /login` → branded sign-in page. If already authenticated, redirect to `/admin/live`.
- `POST /login` → verify credentials, create session, set cookie, 302 `/admin/live`.
  On failure: re-render with generic "invalid email or password".
- `GET  /logout` → destroy session, clear cookie, 302 `/login`.
- `GET  /forgot-password` → branded page.
- `POST /forgot-password` → issue reset token + email if the account exists;
  always render the same "if that address is registered, we've sent a link" page.
- `GET  /set-password?token=…` → validate token; branded set-password page (or an
  "expired/invalid link" state).
- `POST /set-password` → validate token, enforce ≥10 chars + confirmation match,
  set password, consume token, create a session, 302 `/admin/live`.

Changed:

- `requireStaffUser(request, env)` is rewritten to resolve the user from the
  **session cookie** (via `sessions` → `staff_users`) instead of the CF header.
  - Unauthenticated **page** request (`/admin/*`) → 302 to `/login`.
  - Unauthenticated **API** request (`/api/*`) → 401 (JSON/text; no redirect).
  - `AUTH_MODE=dev` + `DEV_STAFF_EMAIL` bypass is **retained** for local dev.
  - The CF-Access verification path and `verifyAccessJwt` are removed.
- The root `/` redirect and all `/webhooks/*`, `/media/*`, `/twiml/*` routes are
  unchanged.

Admin UI:

- `src/html/pages/settings.ts` gains a **Staff access** section (admin-only):
  list staff, "Invite staff" (email + role → creates row, sends invite),
  "Resend invite", "Send reset", "Remove". Backed by new admin-only endpoints
  alongside the existing staff routes: `POST /api/staff` (invite),
  `POST /api/staff/:email/invite` (resend), `POST /api/staff/:email/reset`
  (send reset), `DELETE /api/staff/:email` (remove — also deletes their
  sessions). Existing `GET /api/staff` and the schedule/priority PUTs stay.

## New page renderers

- `src/html/pages/login.ts` — `renderLoginPage`, `renderForgotPasswordPage`,
  `renderSetPasswordPage`. Standalone centered-card layout (NOT the admin nav
  shell), reusing the brand tokens. Minimal inline JS for submit; progressive —
  works as plain form POSTs.

## Security considerations

- Passwords: PBKDF2 210k iters, per-user salt, constant-time verify.
- Only token **hashes** stored server-side; raw tokens only in cookie/email.
- Cookies: `HttpOnly; Secure; SameSite=Lax`.
- Login rate-limiting: a small D1-backed counter table (`login_attempts`, keyed
  by email + a coarse time window) to blunt brute force — in-memory won't do,
  since Worker isolates don't share state. Generic error messages either way.
- No account enumeration on forgot-password. `POST /login` also runs a dummy
  PBKDF2 verify against a fixed dummy hash when the email is unknown, so response
  timing doesn't reveal which emails exist.
- Reset invalidates existing sessions.
- CSRF: `SameSite=Lax` + same-origin form posts is acceptable for v1; a per-form
  token can be added later if needed.

## Out of scope (YAGNI)

- MFA / 2FA.
- "Remember me" / sliding sessions (fixed 12h).
- Social / SSO login.
- Password complexity beyond a 10-char minimum.
- Custom logo image (text "TCB VoIP" wordmark for now; drop-in later).

## Testing

- Unit: `password.ts` (hash roundtrip, wrong password, tampered hash),
  `session.ts` (create/lookup/expire), `tokens.ts` (single-use, expiry, purpose).
- `requireStaffUser`: valid session → user; missing/expired → 302 (page) / 401
  (api); dev bypass.
- Route tests in `test/worker.test.ts`: login success/failure, logout,
  set-password happy path + expired/used token, forgot-password neutrality.
- SendGrid client tested against a mocked fetch.

## Break-glass admin bootstrap (must not depend on email)

Because the new session auth ships with nobody holding a cookie and no password
set, there must be a recovery path that does **not** depend on SendGrid being
live. A tiny Node script (`scripts/set-password.mjs`) computes a PBKDF2 hash with
the exact same format as `password.ts` and prints an `UPDATE staff_users SET
password_hash = …` statement to run via `wrangler d1 execute`. This seeds Phill's
admin password directly and is the always-available way back in if email breaks.
The script must stay byte-compatible with `verifyPassword` (same
`pbkdf2$<iterations>$<salt>$<hash>` format, same iteration count).

## Rollout (verify BEFORE cutover — never disable Access blind)

Sequenced so the literal ask (branded email+password login) lands and is proven
before the SendGrid-dependent layer, and so Access is only removed once login is
confirmed working:

1. Land Phase 1 code + migrations: session auth, login/logout pages,
   break-glass script. New routes are additive; `AUTH_MODE=dev` keeps existing
   behaviour, so nothing breaks while Access is still on.
2. Seed Phill's password with the **break-glass script** (no email needed).
3. **Verify login works while Access is still up** — either on a preview
   deployment, or by temporarily adding `/login`, `/logout`, `/forgot-password`,
   `/set-password` to Cloudflare Access's *bypass/excluded* paths and signing in.
4. Only after login is confirmed: **disable Cloudflare Access** for the hostname.
5. Land Phase 2: SendGrid client, invite/reset flow, staff-admin UI. Set
   `SENDGRID_API_KEY`, `AUTH_FROM_EMAIL`; verify the SendGrid sender on the domain.
6. Invite remaining staff via Settings → Staff access.

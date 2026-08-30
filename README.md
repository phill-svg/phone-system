# phone-system

VOIP phone system built on Cloudflare Workers: Twilio IVR call routing, call history, and a staff admin dashboard.

## Stack

- **Cloudflare Workers** (TypeScript) — `src/worker.ts` is the entry point
- **D1** — call/settings storage (migrations in `migrations/`)
- **Durable Objects** — `CallSession` tracks in-progress call state
- **Twilio** — inbound call webhooks, TwiML responses, signature verification
- **Custom auth** — email + password staff authentication for the admin dashboard (cookie sessions, SendGrid-delivered invite/reset links)

## Prerequisites

- Node.js 18+
- A [Cloudflare account](https://dash.cloudflare.com/) with Workers/D1 enabled
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `npm install`, no global install needed)
- A Twilio account with a phone number, for the IVR flow

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create the D1 database** (or reuse an existing one)

   ```bash
   npx wrangler d1 create tcb-voip-db
   ```

   Copy the returned `database_id` into `wrangler.jsonc` under `d1_databases[0].database_id`.

3. **Apply migrations**

   ```bash
   npx wrangler d1 migrations apply tcb-voip-db --local   # local dev
   npx wrangler d1 migrations apply tcb-voip-db --remote  # production
   ```

4. **Configure secrets and environment variables**

   Create a `.dev.vars` file in the project root for local development (this file is gitignored):

   ```ini
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   AUTH_MODE=dev
   DEV_STAFF_EMAIL=you@example.com
   ```

   - `TWILIO_AUTH_TOKEN` — required; used to verify inbound Twilio webhook signatures.
   - `AUTH_MODE=dev` — bypasses staff login and authenticates all dashboard requests as `DEV_STAFF_EMAIL`. **Local development only** — do not set this in production.
   - `DEV_STAFF_EMAIL` — required when `AUTH_MODE=dev`.

   For production, set the real secrets instead of `AUTH_MODE`:

   ```bash
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put SENDGRID_API_KEY
   ```

   See [Authentication](#authentication) below for the staff login system and the rest of the SendGrid-related config.

5. **Point your Twilio number at the worker**

   Once deployed, set your Twilio phone number's voice webhook to your worker's URL (e.g. `https://tcb-voip.<your-subdomain>.workers.dev/twilio/voice`) — see `src/twilio/` and `src/worker.ts` for the exact routes.

## Development

```bash
npm run dev         # start local dev server (wrangler dev)
npm run test        # run the test suite (vitest)
npm run typecheck   # type-check with tsc
```

## Deploy

Every push to `master` deploys automatically (`.github/workflows/deploy.yml`): it typechecks, runs
the tests, applies any pending D1 migrations, then publishes the worker. The same workflow can be
started by hand from the repo's **Actions** tab via **Run workflow** — which is how to deploy from
a phone, with no terminal involved.

It needs two repository secrets (Settings → Secrets and variables → Actions — the GitHub repo's
settings, not the Cloudflare dashboard):

- `CLOUDFLARE_API_TOKEN` — created from the "Edit Cloudflare Workers" template plus D1 edit.
- `CLOUDFLARE_ACCOUNT_ID` — the hex id in your Cloudflare dashboard URL. Required: without it
  wrangler tries to discover the account through the `/memberships` API, which a scoped API token
  cannot call, and the run fails with "A request to the Cloudflare API (/memberships) failed."

To publish from your own machine instead:

```bash
npm run deploy
```

This runs `wrangler deploy`, publishing the worker to your Cloudflare account. Note that it does
not apply D1 migrations — run `npx wrangler d1 migrations apply tcb-voip-db --remote` first if the
release adds one.

## Authentication

Staff sign in to the admin dashboard with **email + password**. There is no
Cloudflare Access or SSO involved — auth is handled entirely by the worker.

- **Sessions** — cookie-based (`tcb_session`, HttpOnly + Secure), 12-hour
  lifetime. Sessions are looked up in D1 on each request via
  `requireStaffUser` (`src/access/requireStaffUser.ts`).
- **Inviting staff** — an admin invites a new staff member from **Settings →
  Staff access**. The invitee receives a one-time emailed link to set their
  own password. A **"forgot password"** flow on the login page works the same
  way, sending a one-time reset link. Invite and reset emails are sent via
  SendGrid (`src/email/sendgrid.ts`).
- **Required config:**
  - `AUTH_FROM_EMAIL` (`wrangler.jsonc` → `vars`) — the "from" address for
    invite/reset emails. Must be a sender verified on your SendGrid account
    for the domain.
  - `SENDGRID_API_KEY` (secret) — set with:

    ```bash
    npx wrangler secret put SENDGRID_API_KEY
    ```
- **Break-glass (set a password without email)** — if SendGrid is
  unavailable or you need to bootstrap the first admin account, generate a
  password hash locally and write it directly to D1:

  ```bash
  node scripts/set-password.mjs <email> <password>
  ```

  This prints a SQL statement; run it against the remote database with:

  ```bash
  npx wrangler d1 execute tcb-voip-db --remote --command "<statement>"
  ```
- **Local development** — set `AUTH_MODE=dev` and `DEV_STAFF_EMAIL` in
  `.dev.vars` to bypass login entirely and authenticate every dashboard
  request as that staff email. **This is for local development only** — it
  must never be set in production.
- **Cutover runbook** — for the full migration story (why Cloudflare Access
  was removed, rollout steps, verification), see
  [`docs/superpowers/runbooks/auth-cutover.md`](docs/superpowers/runbooks/auth-cutover.md).

### Mobile

The mobile app authenticates via `POST /api/login` (JSON body, returns a
bearer token + user — no cookie), then sends `Authorization: Bearer <token>`
on subsequent API calls. `POST /api/logout` revokes the token.

- `TWILIO_PUSH_CREDENTIAL_SID_IOS` / `TWILIO_PUSH_CREDENTIAL_SID_ANDROID`
  (optional Worker vars) — Twilio Push Credential SIDs used to wake the app
  for incoming calls while backgrounded. Unset until Phase 4 (push
  notifications); with them unset, `GET /api/softphone/token` mints a Voice
  grant with no `push_credential_sid`, so the softphone still works in the
  foreground — only background call push is unavailable.

## Desktop app

A Windows desktop wrapper around the admin dashboard lives in `desktop/` —
see `desktop/README.md` for building and distributing it. It has its own
`package.json` and is not part of any workspace/monorepo tooling; it's built
and run independently of the worker.

## Project structure

```
src/
  access/       Staff auth: sessions, password hashing, tokens, auth guard
  api/          JSON API routes (calls, settings, current user)
  db/           D1 query helpers
  durable-objects/  CallSession durable object
  email/        SendGrid client for invite/reset emails
  html/         Server-rendered admin dashboard pages
  ivr/          IVR state machine, business hours logic
  twilio/       TwiML generation, signature verification, status callbacks
  worker.ts     Entry point / router
migrations/     D1 schema migrations
test/           Vitest test suite (mirrors src/ structure)
docs/           Design specs and implementation plans
desktop/        Electron desktop wrapper app (own package.json, see desktop/README.md)
```

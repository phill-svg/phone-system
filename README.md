# phone-system

VOIP phone system built on Cloudflare Workers: Twilio IVR call routing, call history, and a staff admin dashboard.

## Stack

- **Cloudflare Workers** (TypeScript) — `src/worker.ts` is the entry point
- **D1** — call/settings storage (migrations in `migrations/`)
- **Durable Objects** — `CallSession` tracks in-progress call state
- **Twilio** — inbound call webhooks, TwiML responses, signature verification
- **Cloudflare Access** — staff authentication for the admin dashboard (JWT verification via `jose`)

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
   - `AUTH_MODE=dev` — bypasses Cloudflare Access and authenticates all dashboard requests as `DEV_STAFF_EMAIL`. **Local/dev only** — do not set this in production.
   - `DEV_STAFF_EMAIL` — required when `AUTH_MODE=dev`.

   For production, set the real secret and configure Cloudflare Access instead of `AUTH_MODE`:

   ```bash
   npx wrangler secret put TWILIO_AUTH_TOKEN
   ```

   Then set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.jsonc` under `vars` (or as environment-specific overrides) to your Cloudflare Access team domain and Access application AUD tag, so staff requests are verified against your Access policy.

5. **Point your Twilio number at the worker**

   Once deployed, set your Twilio phone number's voice webhook to your worker's URL (e.g. `https://tcb-voip.<your-subdomain>.workers.dev/twilio/voice`) — see `src/twilio/` and `src/worker.ts` for the exact routes.

## Development

```bash
npm run dev         # start local dev server (wrangler dev)
npm run test        # run the test suite (vitest)
npm run typecheck   # type-check with tsc
```

## Deploy

```bash
npm run deploy
```

This runs `wrangler deploy`, publishing the worker to your Cloudflare account.

## Project structure

```
src/
  access/       Cloudflare Access JWT verification, staff auth guard
  api/          JSON API routes (calls, settings, current user)
  db/           D1 query helpers
  durable-objects/  CallSession durable object
  html/         Server-rendered admin dashboard pages
  ivr/          IVR state machine, business hours logic
  twilio/       TwiML generation, signature verification, status callbacks
  worker.ts     Entry point / router
migrations/     D1 schema migrations
test/           Vitest test suite (mirrors src/ structure)
docs/           Design specs and implementation plans
```

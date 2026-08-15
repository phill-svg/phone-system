# Auth cutover runbook (Phase 1)

Precondition: Phases 1 tasks 1–10 are merged and deployed.

1. Deploy the Worker (`npx wrangler deploy`) with Cloudflare Access STILL ENABLED.
2. Seed the admin password with the break-glass script (no email needed):
   `node scripts/set-password.mjs phill@tcbpestcontrolcanberra.com.au '<strong-pass>'`
   then run the printed SQL:
   `npx wrangler d1 execute tcb-voip-db --remote --command "<the UPDATE statement>"`
3. Verify login WHILE Access is still up — pick one:
   - Preview: deploy to a preview URL not behind Access and sign in there; OR
   - Add `/login`, `/logout`, `/forgot-password`, `/set-password` to the Access
     application's Bypass policy, then visit `/login` and sign in.
   Confirm: correct password → redirected to `/admin/live` and pages load;
   wrong password → "Invalid email or password"; `/admin/live` in a fresh
   private window with no cookie → redirected to `/login`.
4. ONLY after step 3 passes: disable the Cloudflare Access application for the
   hostname in the Zero Trust dashboard.
5. Re-verify: in a fresh private window, `/admin/live` → `/login` (our page, not
   Cloudflare's) → sign in → dashboard. `/webhooks/twilio` still reachable
   (place a test call or confirm Twilio console shows 200s).
6. Rollback if broken: re-enable the Access application; existing sessions and
   the break-glass password remain valid for the next attempt.

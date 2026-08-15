// scripts/set-password.mjs
// Break-glass: set a staff member's password WITHOUT email/SendGrid.
// Usage:
//   node scripts/set-password.mjs <email> <password>
// Then run the printed SQL against D1, e.g.:
//   node scripts/set-password.mjs phill@tcbpestcontrolcanberra.com.au 'SomeStrongPass' \
//     | npx wrangler d1 execute tcb-voip-db --remote --command "$(cat)"
// (or copy the line and pass it to --command directly).
import { pbkdf2Sync, randomBytes } from "node:crypto";

const [, , emailArg, password] = process.argv;
if (!emailArg || !password) {
  console.error("usage: node scripts/set-password.mjs <email> <password>");
  process.exit(1);
}
if (password.length < 10) {
  console.error("password must be at least 10 characters");
  process.exit(1);
}

// Must match src/access/password.ts ITERATIONS. Cloudflare Workers caps PBKDF2
// at 100,000 iterations, so the Worker's verifyPassword rejects anything higher.
const ITER = 100000;
const email = emailArg.toLowerCase();
const safeEmail = email.replace(/'/g, "''");
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITER, 32, "sha256");
const stored = `pbkdf2$${ITER}$${salt.toString("base64")}$${hash.toString("base64")}`;

// Single-quote-safe: base64 never contains a single quote.
console.log(
  `UPDATE staff_users SET password_hash = '${stored}', password_set_at = ${Date.now()} WHERE email = '${safeEmail}';`
);

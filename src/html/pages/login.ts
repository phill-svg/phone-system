import { escapeHtml } from "../layout";

function shell(title: string, cardBody: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — TCB VoIP</title>
<style>
  :root { --bg:#0f1013; --surface:#1b1d24; --border:#26282f; --text:#eceef2; --dim:#a7adb8; --mute:#6d7280; --brand:#e4002b; --link:#ff5c78; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
         display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
  .card { width: 100%; max-width: 340px; background: var(--surface); border: 1px solid var(--border);
          border-radius: 14px; padding: 1.75rem 1.6rem; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  .brand { display: flex; align-items: center; gap: 0.55rem; margin-bottom: 1.35rem; }
  .brand .mark { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(180deg,#e4002b,#c10023);
                 display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 800; font-size: 0.8rem; }
  .brand .word { font-weight: 700; font-size: 0.95rem; }
  h1 { font-size: 1.05rem; margin: 0 0 0.15rem; }
  .subtitle { color: var(--dim); font-size: 0.8rem; margin: 0 0 1.15rem; }
  label { display: block; color: var(--dim); font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 0.35rem; }
  input { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
          padding: 0.6rem 0.7rem; font-size: 0.9rem; margin-bottom: 0.9rem; }
  input:focus { outline: none; border-color: var(--brand); }
  button { width: 100%; background: linear-gradient(180deg,#e4002b,#c10023); color: #fff; border: none; border-radius: 9px;
           padding: 0.65rem; font-weight: 600; font-size: 0.9rem; cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .error { background: rgba(228,0,43,0.14); border: 1px solid rgba(228,0,43,0.4); color: #ff9aab;
           border-radius: 8px; padding: 0.55rem 0.7rem; font-size: 0.8rem; margin-bottom: 0.95rem; }
  .links { text-align: center; margin-top: 0.95rem; font-size: 0.8rem; }
  .links a { color: var(--link); text-decoration: none; }
  .hint { color: var(--mute); font-size: 0.72rem; margin: -0.5rem 0 0.9rem; }
</style>
</head>
<body>
<div class="card">
  <div class="brand"><div class="mark">TCB</div><div class="word">TCB VoIP</div></div>
  ${cardBody}
</div>
</body>
</html>`;
}

export function renderLoginPage(opts?: { error?: string; email?: string }): string {
  const err = opts?.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
  const email = opts?.email ? escapeHtml(opts.email) : "";
  return shell(
    "Sign in",
    `<h1>Sign in</h1>
     <p class="subtitle">Staff access only</p>
     ${err}
     <form method="post" action="/login">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="username" required value="${email}">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required>
       <button type="submit">Sign in</button>
     </form>
     <div class="links"><a href="/forgot-password">Forgot password?</a></div>`
  );
}

export function renderForgotPasswordPage(opts?: { error?: string; done?: boolean }): string {
  if (opts?.done) {
    return shell(
      "Reset password",
      `<h1>Check your email</h1>
       <p class="subtitle">If that address is registered, we've sent a link to reset your password.</p>
       <div class="links"><a href="/login">← Back to sign in</a></div>`
    );
  }
  const err = opts?.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
  return shell(
    "Reset password",
    `<h1>Reset your password</h1>
     <p class="subtitle">Enter your email and we'll send you a link to set a new password.</p>
     ${err}
     <form method="post" action="/forgot-password">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="username" required>
       <button type="submit">Send reset link</button>
     </form>
     <div class="links"><a href="/login">← Back to sign in</a></div>`
  );
}

export function renderSetPasswordPage(opts: { token: string; email: string; error?: string }): string {
  const err = opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : "";
  return shell(
    "Choose a password",
    `<h1>Choose a password</h1>
     <p class="subtitle">for ${escapeHtml(opts.email)}</p>
     ${err}
     <form method="post" action="/set-password">
       <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
       <label for="password">New password</label>
       <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
       <label for="confirm">Confirm password</label>
       <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
       <p class="hint">At least 10 characters.</p>
       <button type="submit">Save &amp; sign in</button>
     </form>`
  );
}

export function renderAuthMessagePage(opts: { title: string; message: string }): string {
  return shell(
    opts.title,
    `<h1>${escapeHtml(opts.title)}</h1>
     <p class="subtitle">${escapeHtml(opts.message)}</p>
     <div class="links"><a href="/login">← Back to sign in</a></div>`
  );
}

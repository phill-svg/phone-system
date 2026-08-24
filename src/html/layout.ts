export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Analytics and IVR Flow are reached from within Settings (sub-sections), not the top nav.
const NAV_ITEMS = [
  { href: "/admin/phone", label: "Phone", key: "phone" },
  { href: "/admin/messages", label: "Messages", key: "messages" },
  { href: "/admin/live", label: "Live Calls", key: "live" },
  { href: "/admin/calls", label: "Call History", key: "calls" },
  { href: "/admin/callbacks", label: "Callback Requests", key: "callbacks" },
  { href: "/admin/settings", label: "Settings", key: "settings", adminOnly: true },
];

// Desktop/web notifications. Injected on every dashboard page so new inbound SMS and calls raise a
// native OS notification whenever the dashboard (browser tab or Electron desktop app) is running --
// including minimised or in the background. No backticks or ${} in here (embedded in a template
// literal below). It polls the same read-only endpoints the pages already use; /api/messages does
// NOT mark anything read, so badges are untouched.
const NOTIFY_JS = [
  '(function(){',
  '  if (!("Notification" in window)) return;',
  '  function ensurePerm(){ try { if (Notification.permission === "default") Notification.requestPermission(); } catch(e){} }',
  '  ensurePerm();',
  '  document.addEventListener("click", ensurePerm, { once: true });',
  '  var LS_MSG = "tcbNotifyLastMsgTs", LS_CALL = "tcbNotifyLastCallTs";',
  '  var lastMsgTs = Number(localStorage.getItem(LS_MSG) || 0);',
  '  var lastCallTs = Number(localStorage.getItem(LS_CALL) || 0);',
  '  var primedMsg = false, primedCall = false;',
  '  function fire(title, body, url, tag){',
  '    if (Notification.permission !== "granted") return;',
  '    try { var n = new Notification(title, { body: body, icon: "/logo.png", tag: tag });',
  '      n.onclick = function(){ try { window.focus(); } catch(e){} if (url) window.location.href = url; n.close(); }; } catch(e){}',
  '  }',
  '  function pollMessages(){',
  '    fetch("/api/messages", { credentials: "same-origin" }).then(function(r){ return r.ok ? r.json() : []; }).then(function(list){',
  '      list = list || []; var maxTs = lastMsgTs;',
  '      for (var i=0;i<list.length;i++){ var c = list[i];',
  '        if (primedMsg && c.unread > 0 && c.last_ts > lastMsgTs) {',
  '          fire("New message", (c.name || c.number) + ": " + (c.last_body || ""), "/admin/messages?to=" + encodeURIComponent(c.number), "msg:" + c.number);',
  '        }',
  '        if (c.last_ts > maxTs) maxTs = c.last_ts;',
  '      }',
  '      lastMsgTs = maxTs; try { localStorage.setItem(LS_MSG, String(maxTs)); } catch(e){} primedMsg = true;',
  '    }).catch(function(){});',
  '  }',
  // NOTE: incoming-CALL notifications are fired in real time from the phone page (phone.ts
  // showIncomingBanner, off the Twilio Device event) — NOT polled here. Polling /api/calls lagged
  // up to 6s and the toast could arrive after the caller had already hung up. Messages stay polled
  // (SMS has no sub-second requirement).',
  '  pollMessages();',
  '  setInterval(pollMessages, 8000);',
  '  // Exposed for the Electron shell to trigger an immediate catch-up on wake/resume.',
  '  window.tcbNotifyPollNow = function(){ pollMessages(); };',
  '})();',
].join("\n");

export function renderLayout(
  title: string,
  activeNav: string,
  body: string,
  opts?: { extraHead?: string; fullWidth?: boolean; role?: "admin" | "staff" }
): string {
  const isAdmin = (opts?.role ?? "admin") === "admin";
  const nav = NAV_ITEMS.filter((item) => isAdmin || !item.adminOnly)
    .map(
      (item) =>
        `<a href="${item.href}" class="nav-link${item.key === activeNav ? " active" : ""}">${escapeHtml(item.label)}</a>`
    )
    .join("");
  const mainClass = opts?.fullWidth ? ' class="full-width"' : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — TCB Phone </title>
<style>
  :root {
    --admin-bg: #0f1013; --admin-surface: #1b1d24; --admin-surface-hover: #22242c;
    --admin-border: #26282f; --admin-text: #eceef2; --admin-dim: #a7adb8;
    --admin-mute: #6d7280; --admin-brand: #e4002b;
  }
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; background: var(--admin-bg); color: var(--admin-text); }
  a { color: #ff5c78; }
  header { background: linear-gradient(180deg, #e4002b, #c10023); color: white; padding: 0.85rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
  header h1 { font-size: 1.05rem; margin: 0; font-weight: 700; letter-spacing: 0.01em; }
  header .brand-logo { width: 32px; height: 32px; background: #fff; border-radius: 7px; padding: 3px; object-fit: contain; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
  .nav-link { color: rgba(255,255,255,0.82); text-decoration: none; font-size: 0.9rem; padding: 0.3rem 0; border-bottom: 2px solid transparent; transition: color 0.12s; }
  .nav-link:hover { color: #fff; }
  .nav-link.active { color: white; font-weight: 600; border-bottom-color: rgba(255,255,255,0.9); }
  main { padding: 1.5rem; max-width: 960px; margin: 0 auto; }
  main.full-width { max-width: none; padding: 0; }
  h1, h2, h3, h4 { color: var(--admin-text); }
  table { width: 100%; border-collapse: collapse; background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 0.65rem 0.8rem; border-bottom: 1px solid var(--admin-border); }
  th { color: var(--admin-dim); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  tbody tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
  .badge-after-hours { background: rgba(228,0,43,0.18); color: #ff8ea0; }
  .placeholder { background: var(--admin-surface); border: 1px dashed var(--admin-border); border-radius: 0.5rem; padding: 1rem; color: var(--admin-mute); margin-top: 1rem; }
  button { background: var(--admin-surface); color: var(--admin-text); border: 1px solid var(--admin-border); border-radius: 0.5rem; padding: 0.4rem 0.9rem; cursor: pointer; font-size: 0.85rem; }
  button:hover:not(:disabled) { background: var(--admin-surface-hover); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input:not([type=checkbox]):not([type=radio]), textarea, select { background: var(--admin-bg); color: var(--admin-text); border: 1px solid var(--admin-border); border-radius: 0.4rem; padding: 0.4rem 0.55rem; font-size: 0.9rem; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--admin-brand); }
  input[type=checkbox] { accent-color: var(--admin-brand); }
  form.settings-form { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 12px; padding: 1.1rem 1.25rem; margin-bottom: 1.25rem; }
  form.settings-form h3, form.settings-form h4 { margin-top: 0; }
  form.settings-form label { display: block; margin-bottom: 0.75rem; }
  form.settings-form input { margin-left: 0.5rem; }
  form.settings-form button[type=submit] { background: var(--admin-brand); border-color: var(--admin-brand); color: #fff; font-weight: 600; margin-top: 0.5rem; }
</style>
${opts?.extraHead ?? ""}
</head>
<body>
<header><img class="brand-logo" src="/logo.png" alt="TCB"><h1>TCB Phone </h1>${nav}</header>
<main${mainClass}>${body}</main>
<script>${NOTIFY_JS}</script>
</body>
</html>`;
}

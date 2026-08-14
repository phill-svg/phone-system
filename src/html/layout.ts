export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAV_ITEMS = [
  { href: "/admin/phone", label: "Phone", key: "phone" },
  { href: "/admin/live", label: "Live Calls", key: "live" },
  { href: "/admin/calls", label: "Call History", key: "calls" },
  { href: "/admin/settings", label: "Settings", key: "settings" },
  { href: "/admin/ivr/main", label: "IVR Flow", key: "ivr" },
  { href: "/admin/callbacks", label: "Callback Requests", key: "callbacks" },
];

export function renderLayout(
  title: string,
  activeNav: string,
  body: string,
  opts?: { extraHead?: string; fullWidth?: boolean }
): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.key === activeNav ? " active" : ""}">${escapeHtml(item.label)}</a>`
  ).join("");
  const mainClass = opts?.fullWidth ? ' class="full-width"' : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — TCB VoIP Admin</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  header { background: linear-gradient(180deg, #e4002b, #c10023); color: white; padding: 0.85rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
  header h1 { font-size: 1.05rem; margin: 0; font-weight: 700; letter-spacing: 0.01em; }
  .nav-link { color: rgba(255,255,255,0.82); text-decoration: none; font-size: 0.9rem; padding: 0.3rem 0; border-bottom: 2px solid transparent; transition: color 0.12s; }
  .nav-link:hover { color: #fff; }
  .nav-link.active { color: white; font-weight: 600; border-bottom-color: rgba(255,255,255,0.9); }
  main { padding: 1.5rem; max-width: 960px; margin: 0 auto; }
  main.full-width { max-width: none; padding: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
  .badge-after-hours { background: #fde8e8; color: #9b1c1c; }
  .placeholder { background: #f3f4f6; border: 1px dashed #9ca3af; border-radius: 0.5rem; padding: 1rem; color: #6b7280; margin-top: 1rem; }
  .placeholder button { cursor: not-allowed; opacity: 0.6; }
  form.settings-form label { display: block; margin-bottom: 0.75rem; }
  form.settings-form input { margin-left: 0.5rem; }
</style>
${opts?.extraHead ?? ""}
</head>
<body>
<header><h1>TCB VoIP Admin</h1>${nav}</header>
<main${mainClass}>${body}</main>
</body>
</html>`;
}

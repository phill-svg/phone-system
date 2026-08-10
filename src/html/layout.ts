export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAV_ITEMS = [
  { href: "/admin/live", label: "Live Calls", key: "live" },
  { href: "/admin/calls", label: "Call History", key: "calls" },
  { href: "/admin/settings", label: "Settings", key: "settings" },
  { href: "/admin/ivr/main", label: "IVR Flow", key: "ivr" },
];

export function renderLayout(title: string, activeNav: string, body: string): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.key === activeNav ? " active" : ""}">${escapeHtml(item.label)}</a>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — TCB VoIP Admin</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  header { background: #1a3d2e; color: white; padding: 1rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; }
  header h1 { font-size: 1.1rem; margin: 0; }
  .nav-link { color: #cfe8db; text-decoration: none; }
  .nav-link.active { color: white; font-weight: 600; }
  main { padding: 1.5rem; max-width: 960px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
  .badge-after-hours { background: #fde8e8; color: #9b1c1c; }
  .placeholder { background: #f3f4f6; border: 1px dashed #9ca3af; border-radius: 0.5rem; padding: 1rem; color: #6b7280; margin-top: 1rem; }
  .placeholder button { cursor: not-allowed; opacity: 0.6; }
  form.settings-form label { display: block; margin-bottom: 0.75rem; }
  form.settings-form input { margin-left: 0.5rem; }
  .ring-entry { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
<header><h1>TCB VoIP Admin</h1>${nav}</header>
<main>${body}</main>
</body>
</html>`;
}

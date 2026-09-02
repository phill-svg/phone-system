import { escapeHtml, renderLayout } from "../layout";

// Admin-only page that shows the exact Twilio webhook URLs (with the CURRENT live whsec) to paste
// into the Twilio console. The secret only ever appears here, behind the admin login — never in
// logs or chat. Also handy when porting numbers (paste these onto the new number).
export function renderWebhooksPage(origin: string, whsec: string, role: "admin" | "staff" = "admin"): string {
  const q = whsec ? `?whsec=${whsec}` : "";
  const rows: { field: string; url: string }[] = [
    { field: 'Phone number → Voice · "A call comes in" (HTTP POST)', url: `${origin}/webhooks/twilio${q}` },
    { field: "Phone number → Voice · Call status changes (POST, optional but recommended)", url: `${origin}/webhooks/twilio/status${q}` },
    { field: "SMS number / Messaging Service / Facebook Messenger sender → inbound message webhook (POST)", url: `${origin}/webhooks/twilio/sms${q}` },
    { field: "Facebook Messenger sender → Status callback URL (delivery status, POST)", url: `${origin}/webhooks/twilio/sms-status${q}` },
    { field: "TwiML App (outbound softphone) → Voice Request URL (POST)", url: `${origin}/twiml/voice-app${q}` },
  ];

  const rowHtml = rows
    .map(
      (r, i) => `<tr>
        <td>${escapeHtml(r.field)}</td>
        <td><code id="wh-${i}" class="wh-url">${escapeHtml(r.url)}</code></td>
        <td><button type="button" class="wh-copy" data-target="wh-${i}">Copy</button></td>
      </tr>`
    )
    .join("");

  const body = `<h2>Twilio Webhook URLs</h2>
    <style>
      .wh-url { display: inline-block; max-width: 560px; overflow-x: auto; white-space: nowrap; background: var(--admin-bg); border: 1px solid var(--admin-border); border-radius: 6px; padding: 0.3rem 0.5rem; font-size: 0.8rem; }
      .wh-copy { padding: 0.3rem 0.8rem; }
      td { vertical-align: top; }
    </style>
    <p style="color:var(--admin-dim);font-size:0.9rem">Paste each URL into the matching field in the Twilio console. These contain your webhook secret, so this page is admin-only — don't share screenshots of it. Method is always <strong>HTTP POST</strong>.</p>
    <table>
      <thead><tr><th>Twilio setting</th><th>URL</th><th></th></tr></thead>
      <tbody>${rowHtml}</tbody>
    </table>
    <script>
      document.querySelectorAll('.wh-copy').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var el = document.getElementById(btn.getAttribute('data-target'));
          var text = el ? el.textContent : '';
          navigator.clipboard.writeText(text).then(function () {
            var old = btn.textContent; btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = old; }, 1200);
          }).catch(function () {});
        });
      });
    </script>`;
  return renderLayout("Webhook URLs", "settings", body, { role });
}

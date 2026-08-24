import { escapeHtml, renderLayout } from "../layout";
import { formatAuNumber } from "../formatPhone";
import type { CallSummary } from "../../db/calls";

export function renderLiveCallsPage(calls: CallSummary[], role: "admin" | "staff" = "admin"): string {
  const rows = calls
    .map(
      (call) => `<tr>
        <td>${escapeHtml(formatAuNumber(call.caller_number))}</td>
        <td>${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</td>
        <td>${
          role === "admin"
            ? `<a class="listen-link" href="/admin/phone?listen=${escapeHtml(encodeURIComponent(call.id))}" title="Join this call muted to listen in">🎧 Listen</a>`
            : ""
        }</td>
      </tr>`
    )
    .join("");
  const body = `<h2>Live Calls</h2>
    <style>
      .listen-link { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.8rem; border-radius: 999px; background: var(--admin-brand); color: #fff; text-decoration: none; font-size: 0.82rem; font-weight: 600; }
      .listen-link:hover { filter: brightness(1.08); }
    </style>
    <table>
      <thead><tr><th>Caller</th><th>Started</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No calls in progress.</td></tr>'}</tbody>
    </table>
    <p style="color:var(--admin-mute);font-size:0.85rem;margin-top:1rem">Click <strong>Listen</strong> to join a call muted — you'll hear both sides but stay silent, and the call is unaffected. Opens in the Phone tab. (Admins only.)</p>`;
  return renderLayout("Live Calls", "live", body, { role });
}

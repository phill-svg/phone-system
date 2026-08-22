import { escapeHtml, renderLayout } from "../layout";
import type { CallSummary } from "../../db/calls";

export function renderLiveCallsPage(calls: CallSummary[], role: "admin" | "staff" = "admin"): string {
  const rows = calls
    .map(
      (call) => `<tr>
        <td>${escapeHtml(call.caller_number)}</td>
        <td>${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</td>
        <td><button disabled>Listen</button></td>
      </tr>`
    )
    .join("");
  const body = `<h2>Live Calls</h2>
    <table>
      <thead><tr><th>Caller</th><th>Started</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No calls in progress!.</td></tr>'}</tbody>
    </table>
    <div class="placeholder">
      <strong>Live transcript &amp; listen-in</strong> — Not available yet, coming in a later phase!.
    </div>`;
  return renderLayout("Live Calls", "live", body, { role });
}

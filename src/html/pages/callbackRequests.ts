import { escapeHtml, renderLayout } from "../layout";
import type { CallbackRequest } from "../../db/callbackRequests";

// Display-only for now: no "mark as done" action wired up yet (would need a PUT/PATCH route to flip
// status to 'done' plus a client-side handler here) -- staff call back manually and this list has
// no way to clear an entry once handled. Out of scope for this task; see task brief.
export function renderCallbackRequestsPage(requests: CallbackRequest[]): string {
  const rows = requests
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.caller_number)}</td>
        <td>${escapeHtml(new Date(r.requested_at).toLocaleString("en-AU"))}</td>
      </tr>`
    )
    .join("");
  const body = `<h2>Callback Requests</h2>
    <table>
      <thead><tr><th>Caller</th><th>Requested</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="2">No open callback requests.</td></tr>'}</tbody>
    </table>`;
  return renderLayout("Callback Requests", "callbacks", body);
}

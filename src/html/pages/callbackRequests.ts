import { escapeHtml, renderLayout } from "../layout";
import { formatSydney } from "../formatTime";
import type { CallbackRequest } from "../../db/callbackRequests";

function openRow(r: CallbackRequest): string {
  return `<tr>
    <td>${escapeHtml(r.caller_number)}</td>
    <td>${escapeHtml(formatSydney(r.requested_at))}</td>
    <td><button type="button" data-cb-id="${r.id}" data-cb-status="done">Mark done</button></td>
  </tr>`;
}

function doneRow(r: CallbackRequest): string {
  const by = r.done_by ? escapeHtml(r.done_by) : "unknown";
  const when = r.done_at ? escapeHtml(formatSydney(r.done_at)) : "—";
  return `<tr>
    <td>${escapeHtml(r.caller_number)}</td>
    <td>${escapeHtml(formatSydney(r.requested_at))}</td>
    <td>${by}, ${when}</td>
    <td><button type="button" data-cb-id="${r.id}" data-cb-status="open">Reopen</button></td>
  </tr>`;
}

// Flip a request's status, then reload so the row moves between the two tables. A reload keeps this
// page as simple as it looks -- there is no client-side list state worth maintaining.
const CLIENT_JS = [
  'document.addEventListener("click",function(e){',
  'var b=e.target.closest("[data-cb-id]");if(!b)return;',
  'b.disabled=true;',
  'fetch("/api/callback-requests/"+b.getAttribute("data-cb-id"),{method:"PUT",credentials:"same-origin",',
  'headers:{"Content-Type":"application/json"},body:JSON.stringify({status:b.getAttribute("data-cb-status")})})',
  '.then(function(r){if(!r.ok)throw new Error("failed");location.reload();})',
  '.catch(function(){b.disabled=false;alert("Could not update that callback request.");});',
  '});',
].join("");

// Takes the full list (open requests plus a bounded tail of handled ones) and splits it here, so the
// page shows the work queue first and the history below it.
export function renderCallbackRequestsPage(
  requests: CallbackRequest[],
  role: "admin" | "staff" = "admin"
): string {
  const open = requests.filter((r) => r.status === "open");
  const done = requests.filter((r) => r.status === "done");

  const openTable = `<table>
      <thead><tr><th>Caller</th><th>Requested</th><th></th></tr></thead>
      <tbody>${open.map(openRow).join("") || '<tr><td colspan="3">No open callback requests.</td></tr>'}</tbody>
    </table>`;

  const doneTable = done.length
    ? `<h3>Completed</h3>
    <table>
      <thead><tr><th>Caller</th><th>Requested</th><th>Called back by</th><th></th></tr></thead>
      <tbody>${done.map(doneRow).join("")}</tbody>
    </table>`
    : "";

  const body = `<h2>Callback Requests</h2>
    ${openTable}
    ${doneTable}
    <script>${CLIENT_JS}</script>`;
  return renderLayout("Callback Requests", "callbacks", body, { role });
}

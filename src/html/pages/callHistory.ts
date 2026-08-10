import { escapeHtml, renderLayout } from "../layout";
import type { CallSummary } from "../../db/calls";

const OUTCOME_LABELS: Record<string, string> = {
  new_booking: "New booking/enquiry",
  existing_job: "Existing job",
  emergency: "Emergency",
  operator: "Operator",
  voicemail: "Voicemail",
};

// Fallback for ivr_path values that aren't in OUTCOME_LABELS (the common case since the flow-engine
// rewrite in Task 9 -- ivr_path is now a dynamic flow-node id or voicemail mailboxLabel, neither of
// which matches the old fixed vocabulary above). Just make the raw snake_case id more readable rather
// than fully redesigning outcome labeling, which is out of scope here.
function humanizeIvrPath(path: string): string {
  return path
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatOutcome(call: CallSummary): string {
  if (call.status === "in_progress") return "In progress";
  if (!call.ivr_path) return "Abandoned";
  return OUTCOME_LABELS[call.ivr_path] ?? humanizeIvrPath(call.ivr_path);
}

export function renderCallHistoryPage(calls: CallSummary[]): string {
  const rows = calls
    .map(
      (call) => `<tr>
        <td><a href="/admin/calls/${escapeHtml(encodeURIComponent(call.id))}">${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</a></td>
        <td>${escapeHtml(call.caller_number)}</td>
        <td>${escapeHtml(formatOutcome(call))}</td>
        <td>${call.is_after_hours ? '<span class="badge badge-after-hours">After hours</span>' : ""}</td>
      </tr>`
    )
    .join("");
  const body = `<h2>Call History</h2>
    <form class="settings-form" id="dialer-form">
      <h3>Call a number</h3>
      <input type="text" id="dialer-number" placeholder="+61...">
      <button type="submit">Call</button>
      <span id="dialer-status"></span>
    </form>
    <table>
      <thead><tr><th>Started</th><th>Caller</th><th>Outcome</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No calls yet.</td></tr>'}</tbody>
    </table>
    <script>
      document.getElementById('dialer-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        const status = document.getElementById('dialer-status');
        const to = document.getElementById('dialer-number').value;
        const res = await fetch('/api/calls/outbound', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: to }),
        });
        status.textContent = res.ok ? 'Calling...' : 'Failed to place call.';
      });
    </script>`;
  return renderLayout("Call History", "calls", body);
}

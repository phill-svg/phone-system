import { escapeHtml, renderLayout } from "../layout";
import type { CallEventRow, CallSummary } from "../../db/calls";

function formatEvent(event: CallEventRow): string {
  try {
    const detail = event.detail ? JSON.parse(event.detail) : null;
    const nextName = detail?.next?.name ?? "?";
    const tag = detail?.next?.tag;
    return `${event.event_type}: → ${nextName}${tag ? ` (tag: ${tag})` : ""}`;
  } catch {
    return event.event_type;
  }
}

export function renderCallDetailPage(call: CallSummary, events: CallEventRow[]): string {
  const eventRows = events
    .map(
      (event) =>
        `<tr><td>${escapeHtml(new Date(event.ts).toLocaleString("en-AU"))}</td><td>${escapeHtml(formatEvent(event))}</td></tr>`
    )
    .join("");
  const body = `<h2>Call ${escapeHtml(call.id)}</h2>
    <p><strong>Caller:</strong> ${escapeHtml(call.caller_number)} &rarr; ${escapeHtml(call.called_number)}</p>
    <p><strong>Started:</strong> ${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</p>
    <p><strong>Status:</strong> ${escapeHtml(call.status)}</p>
    <h3>Timeline</h3>
    <table><tbody>${eventRows || "<tr><td>No events.</td></tr>"}</tbody></table>
    <div class="placeholder">
      <strong>Recording</strong> — Not available yet, coming in a later phase.
      <div><button disabled>Play recording</button></div>
    </div>
    <div class="placeholder">
      <strong>Transcript</strong> — Not available yet, coming in a later phase.
    </div>`;
  return renderLayout(`Call ${call.id}`, "calls", body);
}

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
    ${call.disposition || call.notes ? `<p><strong>Disposition:</strong> ${escapeHtml(call.disposition ?? "—")}</p>${call.notes ? `<p><strong>Notes:</strong> ${escapeHtml(call.notes)}</p>` : ""}` : ""}
    <h3>Timeline</h3>
    <table><tbody>${eventRows || "<tr><td>No events.</td></tr>"}</tbody></table>
    ${
      call.recording_url
        ? `<p><strong>Recording:</strong> <a href="${escapeHtml(call.recording_url)}" target="_blank" rel="noopener">Open recording</a></p>`
        : ""
    }
    ${
      call.transcription
        ? `<h3>Voicemail transcript</h3><p style="white-space:pre-wrap">${escapeHtml(call.transcription)}</p>`
        : ""
    }`;
  return renderLayout(`Call ${call.id}`, "calls", body);
}

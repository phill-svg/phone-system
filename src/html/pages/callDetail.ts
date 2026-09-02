import { escapeHtml, renderLayout } from "../layout";
import { formatAuNumber } from "../formatPhone";
import type { CallEventRow, CallSummary } from "../../db/calls";

// Recording length in m:ss. Twilio's streamed mp3 gives the native <audio> control no usable
// duration, so we render the seconds it reported on the recording-status callback instead.
function fmtSecs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

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

export function renderCallDetailPage(call: CallSummary, events: CallEventRow[], role: "admin" | "staff" = "admin"): string {
  const eventRows = events
    .map(
      (event) =>
        `<tr><td>${escapeHtml(new Date(event.ts).toLocaleString("en-AU"))}</td><td>${escapeHtml(formatEvent(event))}</td></tr>`
    )
    .join("");
  const body = `<h2>Call ${escapeHtml(call.id)}</h2>
    <p><strong>Caller:</strong> ${escapeHtml(formatAuNumber(call.caller_number))} &rarr; ${escapeHtml(formatAuNumber(call.called_number))}</p>
    <p><strong>Started:</strong> ${escapeHtml(new Date(call.started_at).toLocaleString("en-AU"))}</p>
    <p><strong>Status:</strong> ${escapeHtml(call.status)}</p>
    ${call.disposition || call.notes ? `<p><strong>Disposition:</strong> ${escapeHtml(call.disposition ?? "—")}</p>${call.notes ? `<p><strong>Notes:</strong> ${escapeHtml(call.notes)}</p>` : ""}` : ""}
    <h3>Timeline</h3>
    <table><tbody>${eventRows || "<tr><td>No events.</td></tr>"}</tbody></table>
    ${
      call.recording_sid
        ? `<p><strong>Recording:</strong>${
            call.recording_duration ? ` <span>(${fmtSecs(call.recording_duration)})</span>` : ""
          }</p>
    <audio controls preload="none" src="/api/calls/${encodeURIComponent(call.id)}/recording" style="width:100%;max-width:420px"></audio>
    <p><a href="/api/calls/${encodeURIComponent(call.id)}/recording" download="recording-${encodeURIComponent(call.id)}.mp3">Download recording</a></p>`
        : ""
    }
    ${
      call.transcription
        ? `<h3>Voicemail transcript</h3><p style="white-space:pre-wrap">${escapeHtml(call.transcription)}</p>`
        : ""
    }
    ${
      call.call_transcript
        ? `<h3>Call transcript</h3><p style="white-space:pre-wrap">${escapeHtml(call.call_transcript)}</p>`
        : ""
    }`;
  return renderLayout(`Call ${call.id}`, "calls", body, { role });
}

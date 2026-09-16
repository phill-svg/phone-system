import { escapeHtml, renderLayout } from "../layout";
import { formatAuNumber } from "../formatPhone";
import { formatSydney } from "../formatTime";
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
        `<tr><td>${escapeHtml(formatSydney(event.ts))}</td><td>${escapeHtml(formatEvent(event))}</td></tr>`
    )
    .join("");
  const body = `<h2>Call ${escapeHtml(call.id)}</h2>
    <p><strong>Caller:</strong> ${escapeHtml(formatAuNumber(call.caller_number))} &rarr; ${escapeHtml(formatAuNumber(call.called_number))}</p>
    <p><strong>Started:</strong> ${escapeHtml(formatSydney(call.started_at))}</p>
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
        : role === "admin"
          ? // No recording linked. This can mean Twilio genuinely never recorded the call, or that
            // the recording-status callback that was meant to tell us about it never landed (a
            // dropped webhook, a redelivery race -- this repo has hit both). The button asks Twilio
            // directly by CallSid rather than leaving that unrecoverable from here.
            `<p><strong>Recording:</strong> none on file.
    <button id="recover-btn" data-call-id="${escapeHtml(call.id)}" onclick="recoverRecording(this)">Check Twilio for it</button></p>
    <p id="recover-result"></p>`
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
    }
    ${!call.recording_sid && role === "admin" ? RECOVER_SCRIPT : ""}`;
  // No nav key: Call History is gone (the handset has the same list), so this page is reached
  // from a Voicemail row or a link, and highlighting a section that no longer exists would lie.
  return renderLayout(`Call ${call.id}`, "", body, { role });
}

// Plain onclick + fetch, matching this app's existing admin pages -- no build step, no bundler,
// same-origin cookie auth carries the admin session the API route itself checks.
const RECOVER_SCRIPT = `<script>
function recoverRecording(btn) {
  var id = btn.getAttribute('data-call-id');
  var result = document.getElementById('recover-result');
  btn.disabled = true;
  btn.textContent = 'Checking Twilio...';
  fetch('/api/calls/' + encodeURIComponent(id) + '/recover-recording', { method: 'POST', credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.recovered) {
        result.textContent = 'Found it. Reloading...';
        setTimeout(function () { location.reload(); }, 800);
      } else {
        btn.disabled = false;
        btn.textContent = 'Check Twilio for it';
        result.textContent = data.reason || data.error || 'No recording found.';
      }
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = 'Check Twilio for it';
      result.textContent = 'Request failed -- try again.';
    });
}
</script>`;

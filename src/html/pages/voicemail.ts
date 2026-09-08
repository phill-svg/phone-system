import { escapeHtml, renderLayout } from "../layout";
import { formatAuNumber } from "../formatPhone";
import type { CallSummary } from "../../db/calls";

// Seconds as m:ss. Twilio's streamed mp3 gives the native <audio> control no usable duration, so
// the length reported on the recording-status callback is rendered instead.
function fmtSecs(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

// Every voicemail on one page, each playable where it sits.
//
// Until now a voicemail was only findable by scrolling call history and knowing that "Voicemail" in
// the outcome column meant there was audio behind it. That is fine for auditing a call and useless
// for the actual job, which is working through the messages people left.
export function renderVoicemailPage(
  calls: CallSummary[],
  contactNames: Map<string, string>,
  role: "admin" | "staff"
): string {
  const rows = calls
    .map((call) => {
      const src = `/api/calls/${encodeURIComponent(call.id)}/recording`;
      const name = contactNames.get(call.caller_number);
      const who = name
        ? `${escapeHtml(name)} <span class="vm-num">${escapeHtml(formatAuNumber(call.caller_number))}</span>`
        : escapeHtml(formatAuNumber(call.caller_number));
      return `<article class="vm">
        <div class="vm-head">
          <div>
            <strong class="vm-who">${who}</strong>
            <div class="vm-meta">${escapeHtml(fmtWhen(call.started_at))}${
              call.recording_duration ? ` &middot; ${escapeHtml(fmtSecs(call.recording_duration))}` : ""
            }${call.mailbox_label ? ` &middot; ${escapeHtml(call.mailbox_label)}` : ""}</div>
          </div>
          <div class="vm-actions">
            <a href="tel:${escapeHtml(call.caller_number)}" class="vm-btn">Call back</a>
            <a href="/admin/calls/${escapeHtml(encodeURIComponent(call.id))}" class="vm-btn">Details</a>
          </div>
        </div>
        <audio controls preload="none" src="${escapeHtml(src)}"></audio>
        ${
          call.transcription
            ? `<p class="vm-transcript">${escapeHtml(call.transcription)}</p>`
            : '<p class="vm-transcript vm-none">No transcript.</p>'
        }
        <p class="vm-download"><a href="${escapeHtml(src)}" download="voicemail-${escapeHtml(encodeURIComponent(call.id))}.mp3">Download</a></p>
      </article>`;
    })
    .join("");

  const body = `<h2>Voicemail</h2>
    <style>
      .vm { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 12px; padding: 0.9rem 1.1rem; margin-bottom: 0.9rem; }
      .vm-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
      .vm-who { font-size: 1rem; }
      .vm-num { color: var(--admin-dim); font-weight: 400; font-family: monospace; font-size: 0.85rem; margin-left: 0.4rem; }
      .vm-meta { color: var(--admin-dim); font-size: 0.82rem; margin-top: 0.15rem; }
      .vm-actions { display: flex; gap: 0.5rem; }
      .vm-btn { text-decoration: none; font-size: 0.82rem; padding: 0.3rem 0.7rem; border: 1px solid var(--admin-border); border-radius: 999px; color: var(--admin-text); }
      .vm-btn:hover { border-color: var(--admin-brand); }
      .vm audio { width: 100%; max-width: 460px; }
      .vm-transcript { margin: 0.6rem 0 0; font-size: 0.9rem; line-height: 1.45; }
      .vm-none { color: var(--admin-dim); font-style: italic; }
      .vm-download { margin: 0.5rem 0 0; font-size: 0.8rem; }
      .vm-empty { color: var(--admin-dim); }
    </style>
    ${calls.length === 0 ? '<p class="vm-empty">No voicemails yet.</p>' : rows}`;
  return renderLayout("Voicemail", "voicemail", body, { role });
}

import { escapeHtml, renderLayout } from "../layout";
import { formatSydney } from "../formatTime";
import { formatAuNumber } from "../formatPhone";
import type { CallSummary } from "../../db/calls";

// Seconds as m:ss. Twilio's streamed mp3 gives the native <audio> control no usable duration, so
// the length reported on the recording-status callback is rendered instead.
function fmtSecs(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// One player, moved to whichever row is playing. Six native <audio> controls stacked down a page is
// a wall of chrome, and each one preloads its own connection; a single element also means starting
// a second message stops the first, which is what "playing through the voicemails" actually wants.
// No backticks or ${} in here -- it is embedded in a template literal.
const CLIENT_JS = `
document.addEventListener("click", function (ev) {
  var btn = ev.target.closest(".vm-play");
  if (!btn) return;
  var audio = document.getElementById("vm-audio");
  var row = btn.closest("tr");
  var playing = row.classList.contains("vm-playing");
  document.querySelectorAll(".vm-playing").forEach(function (r) { r.classList.remove("vm-playing"); });
  document.querySelectorAll(".vm-play").forEach(function (b) { b.textContent = "Play"; });
  if (playing) { audio.pause(); audio.removeAttribute("src"); return; }
  audio.src = btn.dataset.src;
  audio.play();
  row.classList.add("vm-playing");
  btn.textContent = "Stop";
});
document.getElementById("vm-audio").addEventListener("ended", function () {
  document.querySelectorAll(".vm-playing").forEach(function (r) { r.classList.remove("vm-playing"); });
  document.querySelectorAll(".vm-play").forEach(function (b) { b.textContent = "Play"; });
});
`;

// Every voicemail on one page, newest first.
//
// Until now a voicemail was only findable by scrolling Call History and knowing that "Voicemail" in
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
      const number = formatAuNumber(call.caller_number);
      // The name is the useful line; the number stays beneath it so a callback never needs a
      // second click to find one.
      const who = name
        ? `${escapeHtml(name)}<div class="vm-sub">${escapeHtml(number)}</div>`
        : escapeHtml(number);
      const transcript = call.transcription?.trim();
      return `<tr>
        <td><a href="/admin/calls/${escapeHtml(encodeURIComponent(call.id))}">${escapeHtml(formatSydney(call.started_at))}</a>${
        call.mailbox_label ? `<div class="vm-sub">${escapeHtml(call.mailbox_label)}</div>` : ""
      }</td>
        <td>${who}</td>
        <td class="vm-len">${call.recording_duration === null ? "" : escapeHtml(fmtSecs(call.recording_duration))}</td>
        <td class="vm-msg">${
          transcript ? escapeHtml(transcript) : '<span class="vm-none">No transcript</span>'
        }</td>
        <td class="vm-actions"><button type="button" class="vm-play" data-src="${escapeHtml(src)}">Play</button> <a href="${escapeHtml(
        src
      )}" download="voicemail-${escapeHtml(encodeURIComponent(call.id))}.mp3">Save</a></td>
      </tr>`;
    })
    .join("");

  const body = `<h2>Voicemail</h2>
    <style>
      .vm-sub { color: var(--admin-mute); font-size: 0.78rem; margin-top: 0.15rem; }
      .vm-len { color: var(--admin-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .vm-msg { color: var(--admin-dim); font-size: 0.85rem; line-height: 1.4; }
      .vm-none { color: var(--admin-mute); font-style: italic; }
      .vm-actions { white-space: nowrap; text-align: right; }
      .vm-actions a { font-size: 0.8rem; margin-left: 0.5rem; }
      .vm-playing { background: var(--admin-surface-hover); }
      .vm-playing .vm-play { border-color: var(--admin-brand); color: #ff8ea0; }
    </style>
    <table>
      <thead><tr><th>Received</th><th>From</th><th>Length</th><th>Message</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No voicemails yet.</td></tr>'}</tbody>
    </table>
    <audio id="vm-audio"></audio>
    <script>${CLIENT_JS}</script>`;
  return renderLayout("Voicemail", "voicemail", body, { role });
}

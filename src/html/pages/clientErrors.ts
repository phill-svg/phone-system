import { escapeHtml, renderLayout } from "../layout";
import { formatSydney } from "../formatTime";
import type { ClientErrorRow } from "../../db/clientErrors";

// What the app reported when it fell over.
//
// Nothing recorded a mobile crash until now: TestFlight's crash logs need an App Store Connect API
// key that isn't set, and Play's Developer Reporting API is disabled on the project. When the app
// began crash-looping there was no stack trace to read and no way to get one -- the fix was a
// rollback and a guess. This page is the answer to "what actually broke?".
export function renderClientErrorsPage(rows: ClientErrorRow[], role: "admin" | "staff"): string {
  const cards = rows
    .map((row) => {
      // A gap between the crash and the report means the app could not send it before dying and
      // held it until the next launch -- which is itself the strongest evidence a crash was fatal.
      const delayMs = row.received_at - row.occurred_at;
      const heldBack = delayMs > 60_000 ? ` &middot; reported ${Math.round(delayMs / 60_000)} min later` : "";
      return `<article class="ce${row.fatal ? " ce-fatal" : ""}">
        <div class="ce-head">
          <span class="ce-tag">${row.fatal ? "Crash" : "Caught"}</span>
          <strong>${escapeHtml(row.name ? `${row.name}: ${row.message}` : row.message)}</strong>
        </div>
        <div class="ce-meta">${escapeHtml(formatSydney(row.occurred_at))}${heldBack} &middot; ${escapeHtml(
          row.platform
        )}${row.ota_build ? ` &middot; OTA #${escapeHtml(row.ota_build)}` : ""}${
        row.app_version ? ` &middot; v${escapeHtml(row.app_version)}` : ""
      }${row.screen ? ` &middot; on <code>${escapeHtml(row.screen)}</code>` : ""}${
        row.staff_email ? ` &middot; ${escapeHtml(row.staff_email)}` : ""
      }</div>
        ${row.stack ? `<pre class="ce-stack">${escapeHtml(row.stack)}</pre>` : ""}
      </article>`;
    })
    .join("");

  const body = `<h2>App Errors</h2>
    <p class="ce-intro">Crashes and caught errors reported by the mobile app. A report that arrived
    minutes after it happened was held on the device because the app went down before it could send
    &mdash; that delay is the signature of a real crash rather than a handled one.</p>
    <style>
      .ce-intro { color: var(--admin-dim); font-size: 0.88rem; max-width: 60ch; line-height: 1.5; }
      .ce { background: var(--admin-surface); border: 1px solid var(--admin-border); border-left-width: 3px; border-radius: 10px; padding: 0.8rem 1rem; margin-bottom: 0.8rem; }
      .ce-fatal { border-left-color: #d9534f; }
      .ce-head { display: flex; gap: 0.6rem; align-items: baseline; }
      .ce-tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--admin-dim); border: 1px solid var(--admin-border); border-radius: 999px; padding: 0.1rem 0.5rem; flex: none; }
      .ce-fatal .ce-tag { color: #d9534f; border-color: #d9534f; }
      .ce-meta { color: var(--admin-dim); font-size: 0.8rem; margin-top: 0.35rem; }
      .ce-stack { margin: 0.6rem 0 0; padding: 0.6rem 0.8rem; background: var(--admin-bg); border-radius: 8px; font-size: 0.75rem; line-height: 1.45; overflow-x: auto; white-space: pre; }
      .ce-empty { color: var(--admin-dim); }
    </style>
    ${rows.length === 0 ? '<p class="ce-empty">Nothing reported. That is the good outcome.</p>' : cards}`;
  return renderLayout("App Errors", "errors", body, { role });
}

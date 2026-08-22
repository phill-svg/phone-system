import { renderLayout, escapeHtml } from "../layout";

// Embeds a value as a JSON literal inside a <script> block. Guards against a stray
// "</script>" breaking out of the script tag early (same helper as ivrFlow.ts).
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Version resolved live from `https://registry.npmjs.org/@twilio/voice-sdk`'s dist-tags.latest
// at the time this file was written (2026-08-12). As of v2.0 the Voice SDK is no longer hosted
// on Twilio's own CDN (that URL 403s); mirror the Drawflow pattern and pull the npm package's
// own UMD bundle off jsdelivr. The page's core wiring depends on `new Twilio.Device(...)`.
const TWILIO_VOICE_SDK_VERSION = "2.18.3";
const TWILIO_SDK_JS_URL = `https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@${TWILIO_VOICE_SDK_VERSION}/dist/twilio.min.js`;

// Small hand-written inline SVG icons (no icon font/CDN dependency). Monochrome; colour comes
// from `currentColor` unless a fixed fill is needed for a CSS background-image data URI.
const ICON_PHONE = `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M4.4 2.6c.4-.3.9-.3 1.2 0l2 1.7c.3.3.4.7.2 1.1l-1 2c-.1.3-.1.6.1.8l4 4c.2.2.5.2.8.1l2-1c.4-.2.8-.1 1.1.2l1.7 2c.3.3.3.8 0 1.2l-1 .9c-1 .9-2.5 1.1-3.7.5-3.4-1.7-6.2-4.5-7.9-7.9-.6-1.2-.4-2.7.5-3.7l.9-1z"/></svg>`;
const ICON_BACKSPACE = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4h8a1 1 0 011 1v10a1 1 0 01-1 1h-8l-4-6 4-6z"/><path d="M9.7 8.2l3.6 3.6M13.3 8.2l-3.6 3.6"/></svg>`;
const ICON_CHECK_CIRCLE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M6.5 10.3l2.3 2.3 4.7-5.6"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 6v4l3 2"/></svg>`;
const ICON_SLASH_CIRCLE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="8"/><path d="M5 15L15 5"/></svg>`;
const ICON_KEYPAD = `<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor"><circle cx="5" cy="5" r="1.7"/><circle cx="10" cy="5" r="1.7"/><circle cx="15" cy="5" r="1.7"/><circle cx="5" cy="10" r="1.7"/><circle cx="10" cy="10" r="1.7"/><circle cx="15" cy="10" r="1.7"/><circle cx="5" cy="15" r="1.7"/><circle cx="10" cy="15" r="1.7"/><circle cx="15" cy="15" r="1.7"/></svg>`;
const ICON_TRANSFER = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11l-3-3M17 13H6l3 3"/></svg>`;
const ICON_SETTINGS = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2.2M10 15v2.2M17.2 10H15M5 10H2.8M14.9 5.1l-1.6 1.6M6.7 13.3l-1.6 1.6M14.9 14.9l-1.6-1.6M6.7 6.7L5.1 5.1"/></svg>`;
const ICON_MIC = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.6" width="6" height="9" rx="3"/><path d="M4.5 9.6a5.5 5.5 0 0011 0"/><path d="M10 15.1v2.3M7 17.4h6"/></svg>`;
const ICON_SPEAKER = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5h3l4-3v11l-4-3H3z"/><path d="M13.2 7.2a4 4 0 010 5.6M15.5 5.2a7 7 0 010 9.6"/></svg>`;
const ICON_CALLS = `<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor"><path d="M4.4 2.6c.4-.3.9-.3 1.2 0l2 1.7c.3.3.4.7.2 1.1l-1 2c-.1.3-.1.6.1.8l4 4c.2.2.5.2.8.1l2-1c.4-.2.8-.1 1.1.2l1.7 2c.3.3.3.8 0 1.2l-1 .9c-1 .9-2.5 1.1-3.7.5-3.4-1.7-6.2-4.5-7.9-7.9-.6-1.2-.4-2.7.5-3.7l.9-1z"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg>`;
// Direction glyphs for call-list rows. The arrow's colour is set by the row class.
const ICON_ARROW_OUTBOUND = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14L14 6M8 6h6v6"/></svg>`;
const ICON_ARROW_INBOUND = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6L6 14M12 14H6V8"/></svg>`;
const ICON_MISSED = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6L6 14M12 14H6V8"/><path d="M14.5 5.5l3 3M17.5 5.5l-3 3"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor"><path d="M6 4l10 6-10 6z"/></svg>`;
const ICON_CONTACTS = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="6.8" r="3"/><path d="M4 16.2a6 6 0 0112 0"/></svg>`;
const ICON_ADD = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>`;
const ICON_IMPORT = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v9M6.5 8.5L10 12l3.5-3.5"/><path d="M4 14v2a1 1 0 001 1h10a1 1 0 001-1v-2"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3L8 15l-4 1 1-4z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l.7 10a1 1 0 001 1h4.6a1 1 0 001-1L15 6"/></svg>`;

export function renderPhonePage(staffEmail: string, role: "admin" | "staff" = "admin"): string {
  const staffInitials = escapeHtml((staffEmail.split("@")[0] || "?").slice(0, 2).toUpperCase());
  const staffEmailSafe = escapeHtml(staffEmail);

  const extraHead = `<style>
      :root {
        --brand: #e4002b;
        --brand-hover: #ff2247;
        --brand-tint: rgba(228,0,43,0.16);
        --app-bg: #0f1013;
        --rail-bg: #0a0b0d;
        --list-bg: #14151a;
        --detail-bg: #0f1013;
        --surface: #1b1d24;
        --surface-hover: #22242c;
        --surface-active: #2a2d37;
        --border: #26282f;
        --border-soft: #1e2027;
        --text: #eceef2;
        --text-dim: #a7adb8;
        --text-mute: #6d7280;
        --ok: #22c55e;
        --ok-dim: rgba(34,197,94,0.16);
        --warn: #eab308;
        --warn-dim: rgba(234,179,8,0.16);
        --shadow-md: 0 6px 20px rgba(0,0,0,0.4);
        --shadow-brand: 0 6px 16px rgba(228,0,43,0.4);
      }
      .phone-app { display: flex; height: calc(100vh - 58px); overflow: hidden; background: var(--app-bg); color: var(--text); font-family: system-ui, sans-serif; }
      .phone-app *::-webkit-scrollbar { width: 10px; }
      .phone-app *::-webkit-scrollbar-thumb { background: #2c2f38; border-radius: 6px; border: 3px solid transparent; background-clip: content-box; }
      #sdk-error { display: none; position: fixed; top: 68px; left: 50%; transform: translateX(-50%); z-index: 60; padding: 0.7rem 1rem; background: var(--brand); color: #fff; border-radius: 0.6rem; font-size: 0.85rem; box-shadow: var(--shadow-md); }

      /* ---- Icon rail ---- */
      .rail { width: 88px; flex-shrink: 0; background: var(--rail-bg); border-right: 1px solid var(--border-soft); display: flex; flex-direction: column; align-items: center; padding: 1rem 0 1.1rem; }
      .rail-item { position: relative; display: flex; flex-direction: column; align-items: center; gap: 0.3rem; color: var(--text-mute); background: none; border: none; padding: 0.6rem 0.4rem; border-radius: 0.7rem; width: 70px; font-size: 0.64rem; font-weight: 500; cursor: pointer; transition: color 0.12s, background 0.12s; }
      .rail-item svg { display: block; }
      .rail-item:hover { color: var(--text); background: rgba(255,255,255,0.05); }
      .rail-item.active { color: #fff; }
      .rail-item.active svg { color: var(--brand); }
      .rail-item.active::before { content: ""; position: absolute; left: -0.4rem; top: 20%; bottom: 20%; width: 3px; border-radius: 0 3px 3px 0; background: var(--brand); }
      .rail-spacer { flex: 1; }
      .rail-fab { width: 48px; height: 48px; border-radius: 50%; background: var(--brand); color: #fff; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--shadow-brand); margin-bottom: 1rem; transition: background 0.12s, transform 0.06s; }
      .rail-fab:hover { background: var(--brand-hover); }
      .rail-fab:active { transform: scale(0.94); }
      .rail-avatar { position: relative; width: 40px; height: 40px; border-radius: 50%; background: #2a2d37; color: #fff; border: none; display: flex; align-items: center; justify-content: center; font-size: 0.76rem; font-weight: 700; cursor: pointer; margin-bottom: 0.9rem; }
      .rail-avatar::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 50%; background: var(--text-mute); border: 2px solid var(--rail-bg); }
      .rail-avatar.presence-available::after { background: var(--ok); }
      .rail-avatar.presence-away::after { background: var(--warn); }
      .rail-avatar.presence-offline::after { background: var(--text-mute); }
      .rail-gear { color: var(--text-mute); background: none; border: none; cursor: pointer; padding: 0.4rem; border-radius: 0.5rem; }
      .rail-gear:hover { color: var(--text); }
      .rail-gear.active { color: var(--brand); }

      /* ---- Middle calls list ---- */
      .list-col { width: 380px; flex-shrink: 0; background: var(--list-bg); border-right: 1px solid var(--border-soft); display: flex; flex-direction: column; min-height: 0; }
      .list-head { display: flex; align-items: center; justify-content: space-between; padding: 1.1rem 1.25rem 0.5rem; }
      .list-head h2 { margin: 0; font-size: 1.35rem; font-weight: 700; }
      .list-status { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; color: var(--text-mute); }
      .list-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--text-mute); }
      .list-status.registered { color: var(--ok); }
      .list-status.registered::before { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-dim); }
      .list-search { padding: 0.4rem 1.25rem 0.7rem; }
      .list-search-box { display: flex; align-items: center; gap: 0.55rem; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 0.55rem 0.95rem; color: var(--text-mute); }
      .list-search-box input { flex: 1; background: none; border: none; outline: none; color: var(--text); font-size: 0.88rem; }
      .list-search-box input::placeholder { color: var(--text-mute); }
      .list-filters { display: flex; gap: 0.5rem; padding: 0 1.25rem 0.7rem; }
      .list-chip { background: var(--surface); border: 1px solid var(--border); color: var(--text-dim); border-radius: 999px; padding: 0.35rem 0.85rem; font-size: 0.8rem; font-weight: 500; cursor: pointer; transition: background 0.12s, color 0.12s; }
      .list-chip:hover { background: var(--surface-hover); color: var(--text); }
      .list-chip.active { background: var(--brand); border-color: var(--brand); color: #fff; }
      .list-scroll { flex: 1; overflow-y: auto; min-height: 0; }
      .list-empty { padding: 2rem 1.25rem; text-align: center; color: var(--text-mute); font-size: 0.85rem; }

      .call-row { display: flex; align-items: center; gap: 0.8rem; padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--border-soft); cursor: pointer; transition: background 0.1s; }
      .call-row:hover { background: var(--surface); }
      .call-row.selected { background: var(--surface-active); box-shadow: inset 3px 0 0 var(--brand); }
      .call-dir { flex-shrink: 0; width: 20px; display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
      .call-dir.missed { color: var(--brand); }
      .call-dir.outbound { color: var(--ok); }
      .call-body { flex: 1; min-width: 0; }
      .call-title { font-size: 0.92rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .call-sub { font-size: 0.76rem; color: var(--text-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 0.1rem; }
      .call-row.missed .call-sub { color: var(--brand); }
      .call-meta { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; }
      .call-time { font-size: 0.72rem; color: var(--text-mute); font-variant-numeric: tabular-nums; text-align: right; }
      .call-rec { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.68rem; color: var(--text-dim); }

      /* ---- Right detail pane ---- */
      .detail-col { flex: 1; overflow-y: auto; min-width: 0; background: var(--detail-bg); }
      .detail-inner { max-width: 560px; margin: 0 auto; padding: 2rem 2rem 3rem; }
      .detail-view { display: none; }
      .detail-view--active { display: block; animation: fadeIn 0.16s ease; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

      .empty-state { height: calc(100vh - 58px); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--text-mute); padding: 2rem; }
      .empty-state .empty-icon { width: 64px; height: 64px; border-radius: 50%; background: var(--surface); display: flex; align-items: center; justify-content: center; margin-bottom: 1.2rem; color: var(--text-dim); }
      .empty-state h3 { margin: 0 0 0.4rem; font-size: 1.15rem; font-weight: 700; color: var(--text-dim); }
      .empty-state p { margin: 0; font-size: 0.9rem; max-width: 300px; }

      .detail-title { margin: 0 0 1.4rem; font-size: 1.25rem; font-weight: 700; }
      .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.35rem 1.4rem 1.5rem; }
      .card + .card { margin-top: 1.1rem; }
      .card-label { margin: 0 0 1rem; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-mute); }

      /* Dialpad */
      .dial-input { width: 100%; box-sizing: border-box; font-size: 1.45rem; font-weight: 600; text-align: center; letter-spacing: 0.02em; padding: 0.75rem 0.8rem; margin-bottom: 1.2rem; background: var(--app-bg); border: 1.5px solid var(--border); border-radius: 0.7rem; color: var(--text); }
      .dial-input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-tint); }
      .dial-input::placeholder { color: var(--text-mute); font-weight: 500; }
      .keypad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.55rem; max-width: 300px; margin: 0 auto 1.35rem; }
      .keypad-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.1rem; background: var(--app-bg); border: 1.5px solid var(--border); border-radius: 0.85rem; padding: 0.75rem 0.4rem; cursor: pointer; color: var(--text); transition: background 0.1s, border-color 0.1s, transform 0.05s; }
      .keypad-btn:hover { background: var(--surface-hover); border-color: #33363f; }
      .keypad-btn:active { transform: scale(0.96); background: var(--brand-tint); border-color: var(--brand); }
      .keypad-digit { font-size: 1.5rem; font-weight: 600; line-height: 1.1; }
      .keypad-letters { font-size: 0.56rem; letter-spacing: 0.1em; color: var(--text-mute); text-transform: uppercase; min-height: 0.7rem; }
      .keypad-actions { display: flex; align-items: center; gap: 0.75rem; max-width: 300px; margin: 0 auto; }
      .call-btn-big { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.9rem 1.2rem; font-size: 1rem; font-weight: 600; background: var(--brand); color: #fff; border: none; border-radius: 999px; cursor: pointer; box-shadow: var(--shadow-brand); transition: background 0.12s, transform 0.05s; }
      .call-btn-big:hover { background: var(--brand-hover); }
      .call-btn-big:active { transform: translateY(1px); }
      .icon-btn { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 50%; background: var(--app-bg); border: 1.5px solid var(--border); color: var(--text-dim); cursor: pointer; flex-shrink: 0; }
      .icon-btn:hover { background: var(--surface-hover); color: var(--text); }

      /* Status */
      .status-menu { display: flex; flex-direction: column; gap: 0.35rem; }
      .status-option { display: flex; align-items: center; gap: 0.75rem; width: 100%; text-align: left; background: none; border: 1.5px solid transparent; border-radius: 0.7rem; padding: 0.65rem 0.7rem; cursor: pointer; color: var(--text); font-size: 0.92rem; font-weight: 500; transition: background 0.12s, border-color 0.12s; }
      .status-option:hover { background: var(--surface-hover); }
      .status-option.active { background: var(--brand-tint); border-color: var(--brand); }
      .status-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .status-icon-available { background: var(--ok-dim); color: var(--ok); }
      .status-icon-away { background: var(--warn-dim); color: var(--warn); }
      .status-icon-offline { background: rgba(255,255,255,0.06); color: var(--text-mute); }
      .status-option-check { margin-left: auto; color: var(--brand); display: none; }
      .status-option.active .status-option-check { display: flex; }
      #away-reason-wrap { display: none; margin: 0.7rem 0 0.2rem; padding: 0.8rem 0.1rem 0.1rem; border-top: 1px solid var(--border); }
      .away-reason-row { display: flex; gap: 0.5rem; }
      .phone-input { font-size: 0.9rem; padding: 0.6rem 0.8rem; background: var(--app-bg); border: 1.5px solid var(--border); border-radius: 0.6rem; color: var(--text); box-sizing: border-box; }
      .phone-input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-tint); }
      .phone-input::placeholder { color: var(--text-mute); }
      .away-reason-row .phone-input { flex: 1; }
      .status-save-line { min-height: 1.1rem; margin: 0.6rem 0 0; font-size: 0.78rem; color: var(--text-dim); }

      .pill-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; border: none; border-radius: 999px; padding: 0.6rem 1.2rem; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: background 0.12s; }
      .pill-btn-primary { background: var(--brand); color: #fff; }
      .pill-btn-primary:hover { background: var(--brand-hover); }
      .pill-btn-secondary { background: var(--app-bg); color: var(--text); border: 1.5px solid var(--border); }
      .pill-btn-secondary:hover { background: var(--surface-hover); }

      /* Active call */
      #active-call-controls { display: none; }
      .active-peer { display: flex; align-items: center; gap: 0.85rem; margin-bottom: 1.2rem; }
      .active-peer-avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--brand-tint); color: var(--brand); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .active-peer-name { font-size: 1.1rem; font-weight: 700; word-break: break-word; }
      .active-peer-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-mute); font-weight: 600; }
      .call-controls-row { display: flex; align-items: center; gap: 0.7rem; }
      .toggle-pill-btn { display: inline-flex; align-items: center; gap: 0.5rem; background: var(--app-bg); border: 1.5px solid var(--border); border-radius: 999px; padding: 0.55rem 1.05rem 0.55rem 0.6rem; color: var(--text); font-size: 0.88rem; font-weight: 500; cursor: pointer; transition: background 0.12s; }
      .toggle-pill-btn:hover { background: var(--surface-hover); }
      .toggle-pill-btn::before { content: ""; width: 22px; height: 22px; border-radius: 50%; background-color: rgba(255,255,255,0.06); background-repeat: no-repeat; background-position: center; flex-shrink: 0; }
      #mute-btn::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23a7adb8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='7' y='2.6' width='6' height='9' rx='3'/%3E%3Cpath d='M4.5 9.6a5.5 5.5 0 0011 0'/%3E%3Cpath d='M10 15.1v2.3'/%3E%3Cpath d='M7 17.4h6'/%3E%3C/svg%3E"); }
      #hold-btn::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%23a7adb8'%3E%3Crect x='6' y='4' width='3' height='12' rx='1'/%3E%3Crect x='11' y='4' width='3' height='12' rx='1'/%3E%3C/svg%3E"); }
      #hangup-btn { margin-left: auto; }
      .round-btn { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 50%; border: none; cursor: pointer; color: white; transition: background 0.12s, transform 0.05s; }
      .round-btn:active { transform: scale(0.94); }
      .round-btn-accept { background: var(--ok); }
      .round-btn-accept:hover { background: #16a34a; }
      .round-btn-reject, .round-btn-hangup { background: var(--brand); }
      .round-btn-reject:hover, .round-btn-hangup:hover { background: var(--brand-hover); }
      .round-btn-reject svg, .round-btn-hangup svg { transform: rotate(135deg); }
      .transfer-panel { margin-top: 1.2rem; padding-top: 1.2rem; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
      .phone-select { padding: 0.55rem 0.7rem; border-radius: 0.6rem; background: var(--app-bg); border: 1.5px solid var(--border); color: var(--text); font-size: 0.85rem; cursor: pointer; }
      .phone-select:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-tint); }
      .transfer-status-line { flex: 0 0 100%; margin: 0.2rem 0 0; font-size: 0.78rem; color: var(--text-dim); }

      /* Call-history detail */
      .info-header { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 1.4rem; }
      .info-avatar { width: 52px; height: 52px; border-radius: 50%; background: var(--surface); display: flex; align-items: center; justify-content: center; color: var(--text-dim); flex-shrink: 0; }
      .info-avatar.missed { background: var(--brand-tint); color: var(--brand); }
      .info-avatar.outbound { background: var(--ok-dim); color: var(--ok); }
      .info-name { font-size: 1.25rem; font-weight: 700; word-break: break-word; }
      .info-when { font-size: 0.82rem; color: var(--text-mute); margin-top: 0.15rem; }
      .info-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.55rem 1.2rem; font-size: 0.88rem; }
      .info-grid dt { color: var(--text-mute); }
      .info-grid dd { margin: 0; color: var(--text); font-variant-numeric: tabular-nums; }
      .info-rec-link { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--brand); text-decoration: none; font-weight: 600; font-size: 0.88rem; }
      .info-rec-link:hover { text-decoration: underline; }
      .info-none { color: var(--text-mute); font-size: 0.85rem; }
      .timeline { list-style: none; margin: 0; padding: 0; }
      .timeline li { display: flex; gap: 0.8rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-soft); font-size: 0.82rem; }
      .timeline li:last-child { border-bottom: none; }
      .timeline .t-when { color: var(--text-mute); flex-shrink: 0; font-variant-numeric: tabular-nums; }

      /* Audio */
      .audio-field { margin-bottom: 1.1rem; }
      .audio-field:last-child { margin-bottom: 0; }
      .audio-field label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; font-weight: 600; color: var(--text-dim); margin-bottom: 0.5rem; }
      .audio-field label svg { color: var(--text-mute); }
      .audio-field .phone-select { width: 100%; box-sizing: border-box; }
      .audio-test-row { display: flex; align-items: center; gap: 0.7rem; margin-top: 0.5rem; }
      .audio-hint { font-size: 0.78rem; color: var(--text-mute); margin: 0.9rem 0 0; }

      /* List-head action buttons (contacts mode) */
      .list-actions { display: none; gap: 0.4rem; padding: 0 1.25rem 0.7rem; }
      .list-actions.show { display: flex; }
      .list-action-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 0.6rem; padding: 0.5rem 0.7rem; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
      .list-action-btn:hover { background: var(--surface-hover); }
      .list-action-btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
      .list-action-btn.primary:hover { background: var(--brand-hover); }

      /* Contact rows */
      .contact-row { display: flex; align-items: center; gap: 0.8rem; padding: 0.7rem 1.25rem; border-bottom: 1px solid var(--border-soft); cursor: pointer; }
      .contact-row:hover { background: var(--surface); }
      .contact-row.selected { background: var(--surface-active); box-shadow: inset 3px 0 0 var(--brand); }
      .contact-avatar { width: 38px; height: 38px; border-radius: 50%; background: var(--surface-active); color: var(--text); display: flex; align-items: center; justify-content: center; font-size: 0.78rem; font-weight: 700; flex-shrink: 0; }
      .contact-body { flex: 1; min-width: 0; }
      .contact-name { font-size: 0.92rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .contact-sub { font-size: 0.76rem; color: var(--text-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 0.1rem; }
      .contact-call { flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%; background: var(--brand); color: #fff; border: none; display: none; align-items: center; justify-content: center; cursor: pointer; }
      .contact-row:hover .contact-call { display: flex; }
      .contact-call:hover { background: var(--brand-hover); }

      /* Contact detail */
      .contact-detail-head { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.4rem; }
      .contact-detail-avatar { width: 60px; height: 60px; border-radius: 50%; background: var(--surface-active); color: var(--text); display: flex; align-items: center; justify-content: center; font-size: 1.3rem; font-weight: 700; flex-shrink: 0; }
      .contact-detail-name { font-size: 1.35rem; font-weight: 700; word-break: break-word; }
      .contact-detail-company { font-size: 0.9rem; color: var(--text-mute); margin-top: 0.15rem; }
      .contact-actions { display: flex; gap: 0.6rem; margin-top: 1.3rem; flex-wrap: wrap; }
      .contact-number-row { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; }
      .contact-number { font-size: 1rem; font-weight: 600; font-variant-numeric: tabular-nums; }

      /* Contact form + import */
      .field { margin-bottom: 1rem; }
      .field label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--text-dim); margin-bottom: 0.4rem; }
      .field .phone-input { width: 100%; }
      .import-drop { border: 1.5px dashed var(--border); border-radius: 0.7rem; padding: 1.2rem; text-align: center; color: var(--text-dim); font-size: 0.85rem; }
      .import-drop input[type=file] { display: block; margin: 0.6rem auto 0; color: var(--text-dim); font-size: 0.82rem; }
      .import-or { text-align: center; font-size: 0.75rem; color: var(--text-mute); margin: 0.9rem 0; text-transform: uppercase; letter-spacing: 0.08em; }
      .import-textarea { width: 100%; box-sizing: border-box; min-height: 120px; resize: vertical; background: var(--app-bg); border: 1.5px solid var(--border); border-radius: 0.6rem; color: var(--text); font-family: ui-monospace, monospace; font-size: 0.8rem; padding: 0.7rem 0.8rem; }
      .import-textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-tint); }
      .import-hint { font-size: 0.78rem; color: var(--text-mute); margin: 0.9rem 0 1.1rem; line-height: 1.5; }
      .import-hint code { background: var(--app-bg); padding: 0.1rem 0.4rem; border-radius: 0.3rem; color: var(--text-dim); }
      .import-result { min-height: 1.2rem; margin: 1rem 0 0; font-size: 0.85rem; color: var(--ok); }
      .import-result.error { color: var(--brand); }

      /* Incoming overlay -- visible from any pane */
      #incoming-banner { display: none; position: fixed; top: 70px; left: 50%; transform: translateX(-50%); z-index: 50; width: min(440px, calc(100vw - 2rem)); background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--brand); border-radius: 14px; padding: 1.1rem 1.2rem; box-shadow: var(--shadow-md); }
      .incoming-banner-row { display: flex; align-items: center; gap: 0.9rem; }
      .incoming-avatar { width: 46px; height: 46px; border-radius: 50%; background: var(--brand-tint); color: var(--brand); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .incoming-avatar svg { animation: ringWiggle 0.9s ease-in-out infinite; }
      @keyframes ringWiggle { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-12deg); } 75% { transform: rotate(12deg); } }
      .incoming-info { flex: 1; min-width: 0; }
      .incoming-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; color: var(--brand); }
      .incoming-caller { font-size: 1rem; font-weight: 700; word-break: break-word; }
      .incoming-actions { display: flex; gap: 0.6rem; flex-shrink: 0; }
      @media (prefers-reduced-motion: reduce) { .incoming-avatar svg, .detail-view--active { animation: none; } }
    </style>`;

  const keys: [string, string][] = [
    ["1", ""],
    ["2", "ABC"],
    ["3", "DEF"],
    ["4", "GHI"],
    ["5", "JKL"],
    ["6", "MNO"],
    ["7", "PQRS"],
    ["8", "TUV"],
    ["9", "WXYZ"],
    ["*", ""],
    ["0", ""],
    ["#", ""],
  ];
  const keypadHtml = keys
    .map(
      ([digit, letters]) =>
        `<button type="button" class="dialpad-btn keypad-btn" data-digit="${digit}"><span class="keypad-digit">${digit}</span><span class="keypad-letters">${letters || "&nbsp;"}</span></button>`
    )
    .join("\n              ");

  const body = `<div class="phone-app">
    <nav class="rail">
      <button type="button" class="rail-item active" id="rail-calls" title="Calls">${ICON_CALLS}<span>Calls</span></button>
      <button type="button" class="rail-item" id="rail-contacts" title="Contacts">${ICON_CONTACTS}<span>Contacts</span></button>
      <div class="rail-spacer"></div>
      <button type="button" class="rail-fab" data-detail="dialpad" title="Dial pad">${ICON_KEYPAD}</button>
      <button type="button" class="rail-avatar" id="rail-avatar" data-detail="status" title="${staffEmailSafe}">${staffInitials}</button>
      <button type="button" class="rail-gear" data-detail="audio" title="Audio devices">${ICON_SETTINGS}</button>
    </nav>

    <div class="list-col">
      <div class="list-head">
        <h2 id="list-title">Calls</h2>
        <span id="device-status" class="list-status">Connecting…</span>
      </div>
      <div class="list-search">
        <div class="list-search-box">${ICON_SEARCH}<input type="text" id="calls-search" placeholder="Search by number"></div>
      </div>
      <div class="list-filters" id="list-filters">
        <button type="button" class="list-chip active" data-filter="all">All</button>
        <button type="button" class="list-chip" data-filter="missed">Missed</button>
        <button type="button" class="list-chip" data-filter="recorded">Recorded</button>
      </div>
      <div class="list-actions" id="list-actions">
        <button type="button" class="list-action-btn primary" id="contact-add-btn">${ICON_ADD}<span>Add</span></button>
        <button type="button" class="list-action-btn" id="contact-import-btn">${ICON_IMPORT}<span>Import CSV</span></button>
      </div>
      <div class="list-scroll" id="calls-list">
        <div class="list-empty">Loading calls…</div>
      </div>
    </div>

    <div class="detail-col">
      <div class="detail-inner">
        <section class="detail-view detail-view--active" data-detail="empty">
          <div class="empty-state">
            <div class="empty-icon">${ICON_CALLS}</div>
            <h3>No call selected</h3>
            <p>Choose a call from the list, or tap the dial pad to start a new call.</p>
          </div>
        </section>

        <section class="detail-view" data-detail="callinfo">
          <div id="call-info"></div>
        </section>

        <section class="detail-view" data-detail="dialpad">
          <h2 class="detail-title">New call</h2>
          <div class="card">
            <input type="text" id="dial-input" class="dial-input" placeholder="Number or extension">
            <div id="dialpad-grid" class="keypad-grid">
              ${keypadHtml}
            </div>
            <div class="keypad-actions">
              <button type="button" id="call-btn" class="call-btn-big">${ICON_PHONE}<span>Call</span></button>
              <button type="button" id="dial-backspace-btn" class="icon-btn" title="Backspace">${ICON_BACKSPACE}</button>
            </div>
          </div>
        </section>

        <section class="detail-view" data-detail="active">
          <h2 class="detail-title">Active call</h2>
          <section class="card" id="active-call-controls">
            <div class="active-peer">
              <div class="active-peer-avatar">${ICON_PHONE}</div>
              <div>
                <div class="active-peer-label">On call with</div>
                <div class="active-peer-name" id="active-call-peer"></div>
              </div>
            </div>
            <div class="call-controls-row">
              <button type="button" id="mute-btn" class="toggle-pill-btn">Mute</button>
              <button type="button" id="hold-btn" class="toggle-pill-btn">Hold</button>
              <button type="button" id="hangup-btn" class="round-btn round-btn-hangup" title="Hang up">${ICON_PHONE}</button>
            </div>
            <div id="transfer-panel" class="transfer-panel">
              <select id="transfer-target-select" class="phone-select"><option value="">Choose staff…</option></select>
              <button type="button" id="transfer-btn" class="pill-btn pill-btn-secondary">${ICON_TRANSFER}<span>Transfer</span></button>
              <button type="button" id="complete-transfer-btn" class="pill-btn pill-btn-primary" style="display:none;">Complete transfer</button>
              <p class="transfer-status-line"><span id="transfer-status"></span></p>
            </div>
          </section>
        </section>

        <section class="detail-view" data-detail="status">
          <h2 class="detail-title">Your status</h2>
          <div class="card" id="status-control">
            <div class="status-menu">
              <button type="button" class="status-option" id="status-available-btn" data-status="available">
                <span class="status-icon status-icon-available">${ICON_CHECK_CIRCLE}</span>
                <span class="status-option-label">Available</span>
                <span class="status-option-check">${ICON_CHECK_CIRCLE}</span>
              </button>
              <button type="button" class="status-option" id="status-away-btn" data-status="away">
                <span class="status-icon status-icon-away">${ICON_CLOCK}</span>
                <span class="status-option-label">Away</span>
                <span class="status-option-check">${ICON_CHECK_CIRCLE}</span>
              </button>
              <button type="button" class="status-option" id="status-offline-btn" data-status="offline">
                <span class="status-icon status-icon-offline">${ICON_SLASH_CIRCLE}</span>
                <span class="status-option-label">Offline</span>
                <span class="status-option-check">${ICON_CHECK_CIRCLE}</span>
              </button>
            </div>
            <div id="away-reason-wrap">
              <div class="away-reason-row">
                <input type="text" id="away-reason-input" class="phone-input" placeholder="Reason (optional)">
                <button type="button" id="away-reason-save-btn" class="pill-btn pill-btn-primary">Set Away</button>
              </div>
            </div>
            <p class="status-save-line"><span id="status-save-status"></span></p>
          </div>
        </section>

        <section class="detail-view" data-detail="audio">
          <h2 class="detail-title">Audio devices</h2>
          <div class="card">
            <div class="audio-field">
              <label for="audio-input-select">${ICON_MIC}<span>Microphone</span></label>
              <select id="audio-input-select" class="phone-select"><option>System default</option></select>
            </div>
            <div class="audio-field">
              <label for="audio-output-select">${ICON_SPEAKER}<span>Speaker</span></label>
              <select id="audio-output-select" class="phone-select"><option>System default</option></select>
              <div class="audio-test-row">
                <button type="button" id="audio-test-btn" class="pill-btn pill-btn-secondary">${ICON_SPEAKER}<span>Test speaker</span></button>
              </div>
            </div>
            <p class="audio-hint" id="audio-hint">Devices appear once the softphone is registered.</p>
          </div>
        </section>

        <section class="detail-view" data-detail="contact">
          <div id="contact-detail"></div>
        </section>

        <section class="detail-view" data-detail="contactform">
          <h2 class="detail-title" id="contactform-title">Add contact</h2>
          <div class="card">
            <input type="hidden" id="contactform-id" value="">
            <div class="field">
              <label for="contactform-name">Name</label>
              <input type="text" id="contactform-name" class="phone-input" placeholder="Jane Smith">
            </div>
            <div class="field">
              <label for="contactform-phone">Phone number</label>
              <input type="text" id="contactform-phone" class="phone-input" placeholder="+61 400 123 456">
            </div>
            <div class="field">
              <label for="contactform-company">Company <span style="color:var(--text-mute);font-weight:400">(optional)</span></label>
              <input type="text" id="contactform-company" class="phone-input" placeholder="Capital Signs">
            </div>
            <div class="contact-actions" style="margin-top:0.4rem">
              <button type="button" id="contactform-save" class="pill-btn pill-btn-primary">Save contact</button>
              <button type="button" id="contactform-cancel" class="pill-btn pill-btn-secondary">Cancel</button>
            </div>
            <p class="import-result" id="contactform-result"></p>
          </div>
        </section>

        <section class="detail-view" data-detail="import">
          <h2 class="detail-title">Import contacts</h2>
          <div class="card">
            <p class="import-hint">Upload or paste a CSV with columns for <code>Name</code>, <code>Phone</code> and (optionally) <code>Company</code>. Exports from Google Contacts, Outlook, your phone, or ServiceM8 all work — I match the columns by their header names. Re-importing updates existing contacts by phone number.</p>
            <div class="import-drop">
              Choose a CSV file
              <input type="file" id="import-file" accept=".csv,text/csv">
            </div>
            <div class="import-or">or paste CSV</div>
            <textarea id="import-textarea" class="import-textarea" placeholder="Name,Phone,Company&#10;Jane Smith,+61 400 123 456,Capital Signs"></textarea>
            <div class="contact-actions" style="margin-top:1rem">
              <button type="button" id="import-run" class="pill-btn pill-btn-primary">${ICON_IMPORT}<span>Import</span></button>
              <button type="button" id="import-cancel" class="pill-btn pill-btn-secondary">Cancel</button>
            </div>
            <p class="import-result" id="import-result"></p>
          </div>
        </section>
      </div>
    </div>

    <div id="sdk-error">Could not load the Twilio Voice SDK. Check your connection and reload the page.</div>

    <div id="incoming-banner">
      <div class="incoming-banner-row">
        <div class="incoming-avatar">${ICON_PHONE}</div>
        <div class="incoming-info">
          <div class="incoming-label">Incoming call</div>
          <div class="incoming-caller" id="incoming-caller"></div>
        </div>
        <div class="incoming-actions">
          <button type="button" id="accept-btn" class="round-btn round-btn-accept" title="Accept">${ICON_PHONE}</button>
          <button type="button" id="reject-btn" class="round-btn round-btn-reject" title="Reject">${ICON_PHONE}</button>
        </div>
      </div>
    </div>
    </div>

    <script src="${TWILIO_SDK_JS_URL}" onerror="document.getElementById('sdk-error').style.display='block'"></script>
    <script>
      var STAFF_EMAIL = ${safeJsonForScript(staffEmail)};
      var device = null;
      var activeCall = null;
      var isOnHold = false;

      // Direction/status glyphs used when building call-list rows in JS.
      var IC_IN = ${safeJsonForScript(ICON_ARROW_INBOUND)};
      var IC_OUT = ${safeJsonForScript(ICON_ARROW_OUTBOUND)};
      var IC_MISS = ${safeJsonForScript(ICON_MISSED)};
      var IC_PLAY = ${safeJsonForScript(ICON_PLAY)};
      var IC_CALL = ${safeJsonForScript(ICON_PHONE)};
      var IC_EDIT = ${safeJsonForScript(ICON_EDIT)};
      var IC_TRASH = ${safeJsonForScript(ICON_TRASH)};

      // ---- Detail-pane router. Owns only .detail-view wrappers via the --active class, never
      // the inline style.display the call JS sets on #active-call-controls inside the "active"
      // wrapper. ----
      function showDetail(name) {
        document.querySelectorAll('.detail-view').forEach(function (v) {
          v.classList.toggle('detail-view--active', v.getAttribute('data-detail') === name);
        });
        document.querySelectorAll('.rail [data-detail]').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-detail') === name);
        });
      }
      document.querySelectorAll('.rail [data-detail]').forEach(function (b) {
        b.addEventListener('click', function () { showDetail(b.getAttribute('data-detail')); });
      });

      // The two rail items at the top switch the MIDDLE column's context (calls vs contacts),
      // Aircall-style, rather than opening a detail view.
      var listMode = 'calls';
      function setListMode(mode) {
        listMode = mode;
        document.getElementById('rail-calls').classList.toggle('active', mode === 'calls');
        document.getElementById('rail-contacts').classList.toggle('active', mode === 'contacts');
        document.getElementById('list-title').textContent = mode === 'calls' ? 'Calls' : 'Contacts';
        document.getElementById('list-filters').style.display = mode === 'calls' ? 'flex' : 'none';
        document.getElementById('list-actions').classList.toggle('show', mode === 'contacts');
        document.getElementById('calls-search').placeholder = mode === 'calls' ? 'Search by number' : 'Search name or number';
        if (mode === 'contacts') renderContacts(); else renderCalls();
      }
      document.getElementById('rail-calls').addEventListener('click', function () {
        clearSelectedRow();
        setListMode('calls');
        showDetail('empty');
      });
      document.getElementById('rail-contacts').addEventListener('click', function () {
        clearSelectedRow();
        setListMode('contacts');
        showDetail('empty');
      });

      // ---- Calls list (recent history from /api/calls) ----
      var allCalls = [];
      var currentFilter = 'all';
      var selectedCallId = null;

      function callDisplayNumber(c) {
        return c.direction === 'outbound' ? (c.called_number || c.caller_number) : c.caller_number;
      }
      function isMissed(c) {
        return c.direction === 'inbound' && !c.ivr_path && c.status !== 'in_progress';
      }
      function humanize(s) {
        return String(s).replace(/_/g, ' ').replace(/\\b\\w/g, function (ch) { return ch.toUpperCase(); });
      }
      function outcomeLabel(c) {
        if (c.status === 'in_progress') return 'In progress';
        if (!c.ivr_path) return isMissed(c) ? 'Missed call' : 'Abandoned';
        return humanize(c.ivr_path);
      }
      function subLabel(c) {
        if (isMissed(c)) return c.ivr_path ? 'Missed call - ' + humanize(c.ivr_path) : 'Missed call';
        if (c.direction === 'outbound') return 'Outgoing call';
        return outcomeLabel(c);
      }
      function pad2(n) { return (n < 10 ? '0' : '') + n; }
      function fmtRowTime(ms) {
        var d = new Date(ms);
        var now = new Date();
        var t = pad2(d.getHours() % 12 || 12) + ':' + pad2(d.getMinutes()) + ' ' + (d.getHours() < 12 ? 'am' : 'pm');
        var yest = new Date(now); yest.setDate(now.getDate() - 1);
        if (d.toDateString() === now.toDateString()) return t;
        if (d.toDateString() === yest.toDateString()) return 'Yesterday';
        return d.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
      }
      function fmtDuration(c) {
        if (!c.ended_at || !c.started_at) return null;
        var secs = Math.max(0, Math.round((c.ended_at - c.started_at) / 1000));
        var m = Math.floor(secs / 60), s = secs % 60;
        return m + ':' + pad2(s);
      }

      function clearSelectedRow() {
        selectedCallId = null;
        document.querySelectorAll('.call-row.selected').forEach(function (r) { r.classList.remove('selected'); });
      }

      function renderCalls() {
        var q = (document.getElementById('calls-search').value || '').toLowerCase();
        var container = document.getElementById('calls-list');
        var list = allCalls.filter(function (c) {
          if (currentFilter === 'missed' && !isMissed(c)) return false;
          if (currentFilter === 'recorded' && !c.recording_url) return false;
          if (q && callDisplayNumber(c).toLowerCase().indexOf(q) === -1) return false;
          return true;
        });
        container.innerHTML = '';
        if (!list.length) {
          var empty = document.createElement('div');
          empty.className = 'list-empty';
          empty.textContent = allCalls.length ? 'No matching calls.' : 'No calls yet.';
          container.appendChild(empty);
          return;
        }
        list.forEach(function (c) {
          var missed = isMissed(c);
          var row = document.createElement('div');
          row.className = 'call-row' + (missed ? ' missed' : '') + (c.id === selectedCallId ? ' selected' : '');
          row.setAttribute('data-id', c.id);

          var dir = document.createElement('div');
          dir.className = 'call-dir ' + (missed ? 'missed' : c.direction);
          dir.innerHTML = missed ? IC_MISS : (c.direction === 'outbound' ? IC_OUT : IC_IN);

          var bodyEl = document.createElement('div');
          bodyEl.className = 'call-body';
          var num = callDisplayNumber(c);
          var contact = contactsByNorm[normalizePhoneJS(num)];
          var title = document.createElement('div');
          title.className = 'call-title';
          title.textContent = contact ? contact.name : num;
          var sub = document.createElement('div');
          sub.className = 'call-sub';
          sub.textContent = subLabel(c);
          bodyEl.appendChild(title);
          bodyEl.appendChild(sub);

          var meta = document.createElement('div');
          meta.className = 'call-meta';
          var time = document.createElement('div');
          time.className = 'call-time';
          time.textContent = fmtRowTime(c.started_at);
          meta.appendChild(time);
          if (c.recording_url) {
            var rec = document.createElement('span');
            rec.className = 'call-rec';
            rec.innerHTML = IC_PLAY;
            meta.appendChild(rec);
          }

          row.appendChild(dir);
          row.appendChild(bodyEl);
          row.appendChild(meta);
          row.addEventListener('click', function () { selectCall(c.id); });
          container.appendChild(row);
        });
      }

      async function loadCalls() {
        try {
          var res = await fetch('/api/calls');
          if (!res.ok) return;
          allCalls = await res.json();
          renderCalls();
        } catch (e) {
          // Non-fatal -- the list just stays as-is.
        }
      }

      async function selectCall(id) {
        selectedCallId = id;
        document.querySelectorAll('.call-row').forEach(function (r) {
          r.classList.toggle('selected', r.getAttribute('data-id') === id);
        });
        showDetail('callinfo');
        var info = document.getElementById('call-info');
        info.innerHTML = '<p class="info-none">Loading call…</p>';
        try {
          var res = await fetch('/api/calls/' + encodeURIComponent(id));
          if (!res.ok) { info.innerHTML = '<p class="info-none">Could not load this call.</p>'; return; }
          var data = await res.json();
          renderCallInfo(data.call, data.events || []);
        } catch (e) {
          info.innerHTML = '<p class="info-none">Could not load this call.</p>';
        }
      }

      function renderCallInfo(c, events) {
        var missed = isMissed(c);
        var info = document.getElementById('call-info');
        info.innerHTML = '';

        var header = document.createElement('div');
        header.className = 'info-header';
        var avatar = document.createElement('div');
        avatar.className = 'info-avatar ' + (missed ? 'missed' : c.direction);
        avatar.innerHTML = missed ? IC_MISS : (c.direction === 'outbound' ? IC_OUT : IC_IN);
        var htext = document.createElement('div');
        var infoContact = contactsByNorm[normalizePhoneJS(callDisplayNumber(c))];
        var name = document.createElement('div');
        name.className = 'info-name';
        name.textContent = infoContact ? infoContact.name : callDisplayNumber(c);
        var when = document.createElement('div');
        when.className = 'info-when';
        when.textContent = new Date(c.started_at).toLocaleString('en-AU');
        htext.appendChild(name); htext.appendChild(when);
        header.appendChild(avatar); header.appendChild(htext);
        info.appendChild(header);

        var card = document.createElement('div');
        card.className = 'card';
        var grid = document.createElement('dl');
        grid.className = 'info-grid';
        var dur = fmtDuration(c);
        var rows = [
          ['Direction', c.direction === 'outbound' ? 'Outgoing' : 'Incoming'],
          ['From', c.caller_number],
          ['To', c.called_number],
          ['Outcome', outcomeLabel(c)],
          ['Status', humanize(c.status)]
        ];
        if (dur) rows.push(['Duration', dur]);
        if (c.is_after_hours) rows.push(['After hours', 'Yes']);
        rows.forEach(function (r) {
          var dt = document.createElement('dt'); dt.textContent = r[0];
          var dd = document.createElement('dd'); dd.textContent = r[1];
          grid.appendChild(dt); grid.appendChild(dd);
        });
        card.appendChild(grid);

        var recWrap = document.createElement('div');
        recWrap.style.marginTop = '1.1rem';
        if (c.recording_url) {
          // Play inline through the authenticated proxy (/api/calls/:id/recording) rather than
          // linking to Twilio's protected URL, which pops a Twilio credential prompt in a new tab.
          var audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'none';
          audio.src = '/api/calls/' + encodeURIComponent(c.id) + '/recording';
          audio.style.width = '100%';
          recWrap.appendChild(audio);
        } else {
          var none = document.createElement('span');
          none.className = 'info-none';
          none.textContent = 'No recording for this call.';
          recWrap.appendChild(none);
        }
        card.appendChild(recWrap);
        info.appendChild(card);

        if (c.transcription) {
          var tcard = document.createElement('div');
          tcard.className = 'card';
          var tlabel = document.createElement('p'); tlabel.className = 'card-label'; tlabel.textContent = 'Voicemail transcript';
          var ttext = document.createElement('p');
          ttext.style.whiteSpace = 'pre-wrap'; ttext.style.margin = '0'; ttext.style.fontSize = '0.9rem';
          ttext.textContent = c.transcription;
          tcard.appendChild(tlabel); tcard.appendChild(ttext);
          info.appendChild(tcard);
        }

        // Disposition + notes editor (saved back to the call).
        var ncard = document.createElement('div');
        ncard.className = 'card';
        var nlabel = document.createElement('p'); nlabel.className = 'card-label'; nlabel.textContent = 'Outcome & notes';
        var dispSel = document.createElement('select');
        dispSel.className = 'phone-select';
        dispSel.style.width = '100%'; dispSel.style.marginBottom = '0.6rem';
        ['', 'New booking', 'Existing job', 'Emergency', 'Callback', 'Spam', 'Other'].forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt; o.textContent = opt || 'No outcome set';
          if ((c.disposition || '') === opt) o.selected = true;
          dispSel.appendChild(o);
        });
        var notesTa = document.createElement('textarea');
        notesTa.className = 'import-textarea';
        notesTa.style.minHeight = '80px';
        notesTa.placeholder = 'Notes about this call…';
        notesTa.value = c.notes || '';
        var saveRow = document.createElement('div');
        saveRow.className = 'contact-actions'; saveRow.style.marginTop = '0.7rem';
        var saveBtn = document.createElement('button');
        saveBtn.type = 'button'; saveBtn.className = 'pill-btn pill-btn-primary'; saveBtn.textContent = 'Save';
        var saveStatus = document.createElement('span');
        saveStatus.style.cssText = 'font-size:0.8rem;color:var(--text-dim);align-self:center';
        saveBtn.addEventListener('click', function () {
          saveStatus.textContent = 'Saving…';
          fetch('/api/calls/' + encodeURIComponent(c.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disposition: dispSel.value, notes: notesTa.value }),
          }).then(function (r) { saveStatus.textContent = r.ok ? 'Saved.' : 'Failed to save.'; })
            .catch(function () { saveStatus.textContent = 'Failed to save.'; });
        });
        saveRow.appendChild(saveBtn); saveRow.appendChild(saveStatus);
        ncard.appendChild(nlabel); ncard.appendChild(dispSel); ncard.appendChild(notesTa); ncard.appendChild(saveRow);
        info.appendChild(ncard);

        if (events.length) {
          var tlCard = document.createElement('div');
          tlCard.className = 'card';
          var label = document.createElement('p');
          label.className = 'card-label';
          label.textContent = 'Timeline';
          var ul = document.createElement('ul');
          ul.className = 'timeline';
          events.forEach(function (ev) {
            var li = document.createElement('li');
            var w = document.createElement('span');
            w.className = 't-when';
            w.textContent = new Date(ev.ts).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
            var txt = document.createElement('span');
            txt.textContent = humanize(ev.event_type);
            li.appendChild(w); li.appendChild(txt);
            ul.appendChild(li);
          });
          tlCard.appendChild(label); tlCard.appendChild(ul);
          info.appendChild(tlCard);
        }
      }

      document.getElementById('calls-search').addEventListener('input', function () {
        if (listMode === 'contacts') renderContacts(); else renderCalls();
      });
      document.querySelectorAll('.list-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          currentFilter = chip.getAttribute('data-filter');
          document.querySelectorAll('.list-chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
          renderCalls();
        });
      });

      // ---- Contacts (contact book + CSV import) ----
      var contacts = [];
      var contactsByNorm = {};
      var selectedContactId = null;

      // Must stay identical to normalizePhone() in src/db/contacts.ts so a call's number matches
      // the stored phone_normalized.
      function normalizePhoneJS(raw) {
        if (!raw) return '';
        var hasPlus = String(raw).trim().charAt(0) === '+';
        var digits = String(raw).replace(/\\D/g, '');
        if (!digits) return '';
        if (hasPlus) return digits;
        if (digits.charAt(0) === '0') return '61' + digits.slice(1);
        return digits;
      }
      function contactInitials(name) {
        var parts = String(name || '?').trim().split(/\\s+/);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
      }

      async function loadContacts() {
        try {
          var res = await fetch('/api/contacts');
          if (!res.ok) return;
          contacts = await res.json();
          contactsByNorm = {};
          contacts.forEach(function (c) { if (c.phone_normalized) contactsByNorm[c.phone_normalized] = c; });
          if (listMode === 'contacts') renderContacts(); else renderCalls();
        } catch (e) {
          // Non-fatal -- names just fall back to raw numbers.
        }
      }

      function renderContacts() {
        var q = (document.getElementById('calls-search').value || '').toLowerCase();
        var container = document.getElementById('calls-list');
        var list = contacts.filter(function (c) {
          if (!q) return true;
          return (c.name || '').toLowerCase().indexOf(q) !== -1
            || (c.company || '').toLowerCase().indexOf(q) !== -1
            || (c.phone || '').toLowerCase().indexOf(q) !== -1;
        });
        container.innerHTML = '';
        if (!list.length) {
          var empty = document.createElement('div');
          empty.className = 'list-empty';
          empty.textContent = contacts.length ? 'No matching contacts.' : 'No contacts yet. Add one or import a CSV.';
          container.appendChild(empty);
          return;
        }
        list.forEach(function (c) {
          var row = document.createElement('div');
          row.className = 'contact-row' + (c.id === selectedContactId ? ' selected' : '');
          row.setAttribute('data-id', c.id);
          var avatar = document.createElement('div');
          avatar.className = 'contact-avatar';
          avatar.textContent = contactInitials(c.name);
          var bodyEl = document.createElement('div');
          bodyEl.className = 'contact-body';
          var nm = document.createElement('div'); nm.className = 'contact-name'; nm.textContent = c.name;
          var sub = document.createElement('div'); sub.className = 'contact-sub';
          sub.textContent = c.company ? c.company + ' · ' + c.phone : c.phone;
          bodyEl.appendChild(nm); bodyEl.appendChild(sub);
          var callBtn = document.createElement('button');
          callBtn.type = 'button'; callBtn.className = 'contact-call'; callBtn.title = 'Call';
          callBtn.innerHTML = IC_CALL;
          callBtn.addEventListener('click', function (e) { e.stopPropagation(); callContact(c.phone); });
          row.appendChild(avatar); row.appendChild(bodyEl); row.appendChild(callBtn);
          row.addEventListener('click', function () { showContact(c.id); });
          container.appendChild(row);
        });
      }

      function showContact(id) {
        var c = contacts.filter(function (x) { return x.id === id; })[0];
        if (!c) return;
        selectedContactId = id;
        document.querySelectorAll('.contact-row').forEach(function (r) {
          r.classList.toggle('selected', r.getAttribute('data-id') === String(id));
        });
        var el = document.getElementById('contact-detail');
        el.innerHTML = '';
        var head = document.createElement('div'); head.className = 'contact-detail-head';
        var av = document.createElement('div'); av.className = 'contact-detail-avatar'; av.textContent = contactInitials(c.name);
        var ht = document.createElement('div');
        var nm = document.createElement('div'); nm.className = 'contact-detail-name'; nm.textContent = c.name;
        ht.appendChild(nm);
        if (c.company) { var co = document.createElement('div'); co.className = 'contact-detail-company'; co.textContent = c.company; ht.appendChild(co); }
        head.appendChild(av); head.appendChild(ht);
        el.appendChild(head);

        var card = document.createElement('div'); card.className = 'card';
        var label = document.createElement('p'); label.className = 'card-label'; label.textContent = 'Phone';
        var numRow = document.createElement('div'); numRow.className = 'contact-number-row';
        var numEl = document.createElement('span'); numEl.className = 'contact-number'; numEl.textContent = c.phone;
        var callRound = document.createElement('button'); callRound.type = 'button'; callRound.className = 'round-btn round-btn-accept'; callRound.title = 'Call';
        callRound.innerHTML = IC_CALL;
        callRound.addEventListener('click', function () { callContact(c.phone); });
        numRow.appendChild(numEl); numRow.appendChild(callRound);
        card.appendChild(label); card.appendChild(numRow);

        var actions = document.createElement('div'); actions.className = 'contact-actions';
        var editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.className = 'pill-btn pill-btn-secondary'; editBtn.innerHTML = IC_EDIT + '<span>Edit</span>';
        editBtn.addEventListener('click', function () { editContact(c); });
        var delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'pill-btn pill-btn-secondary'; delBtn.innerHTML = IC_TRASH + '<span>Delete</span>';
        delBtn.addEventListener('click', function () { deleteContactUI(c); });
        actions.appendChild(editBtn); actions.appendChild(delBtn);
        card.appendChild(actions);
        el.appendChild(card);
        showDetail('contact');
      }

      function callContact(number) {
        document.getElementById('dial-input').value = number;
        showDetail('dialpad');
        if (device) placeCall(number).catch(function (err) { setDeviceStatusText('Call failed: ' + describeError(err)); });
      }

      function openContactForm(c) {
        document.getElementById('contactform-title').textContent = c ? 'Edit contact' : 'Add contact';
        document.getElementById('contactform-id').value = c ? String(c.id) : '';
        document.getElementById('contactform-name').value = c ? c.name : '';
        document.getElementById('contactform-phone').value = c ? c.phone : '';
        document.getElementById('contactform-company').value = c && c.company ? c.company : '';
        var result = document.getElementById('contactform-result');
        result.textContent = ''; result.classList.remove('error');
        showDetail('contactform');
        document.getElementById('contactform-name').focus();
      }
      function newContact() { openContactForm(null); }
      function editContact(c) { openContactForm(c); }

      async function saveContact() {
        var idVal = document.getElementById('contactform-id').value;
        var name = document.getElementById('contactform-name').value.trim();
        var phone = document.getElementById('contactform-phone').value.trim();
        var company = document.getElementById('contactform-company').value.trim();
        var result = document.getElementById('contactform-result');
        result.classList.remove('error');
        if (!name || !phone) {
          result.textContent = 'Name and phone number are required.';
          result.classList.add('error');
          return;
        }
        var url = idVal ? '/api/contacts/' + idVal : '/api/contacts';
        try {
          var res = await fetch(url, {
            method: idVal ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, phone: phone, company: company || null }),
          });
          if (!res.ok) { result.textContent = 'Could not save contact.'; result.classList.add('error'); return; }
          await loadContacts();
          setListMode('contacts');
          showDetail('empty');
        } catch (e) {
          result.textContent = 'Could not save contact.'; result.classList.add('error');
        }
      }

      async function deleteContactUI(c) {
        if (!window.confirm('Delete ' + c.name + '?')) return;
        try {
          var res = await fetch('/api/contacts/' + c.id, { method: 'DELETE' });
          if (!res.ok) return;
          selectedContactId = null;
          await loadContacts();
          setListMode('contacts');
          showDetail('empty');
        } catch (e) {
          // Non-fatal.
        }
      }

      document.getElementById('contact-add-btn').addEventListener('click', newContact);
      document.getElementById('contact-import-btn').addEventListener('click', function () {
        var result = document.getElementById('import-result');
        result.textContent = ''; result.classList.remove('error');
        document.getElementById('import-textarea').value = '';
        var f = document.getElementById('import-file'); if (f) f.value = '';
        showDetail('import');
      });
      document.getElementById('contactform-save').addEventListener('click', saveContact);
      document.getElementById('contactform-cancel').addEventListener('click', function () { setListMode('contacts'); showDetail('empty'); });
      document.getElementById('import-cancel').addEventListener('click', function () { setListMode('contacts'); showDetail('empty'); });

      // Minimal CSV parser -- handles quoted fields with embedded commas/newlines and "" escapes.
      function parseCsv(text) {
        var rows = [], row = [], field = '', inQuotes = false;
        for (var i = 0; i < text.length; i++) {
          var ch = text.charAt(i);
          if (inQuotes) {
            if (ch === '"') {
              if (text.charAt(i + 1) === '"') { field += '"'; i++; } else inQuotes = false;
            } else field += ch;
          } else if (ch === '"') { inQuotes = true; }
          else if (ch === ',') { row.push(field); field = ''; }
          else if (ch === '\\r') { /* ignore */ }
          else if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; }
          else field += ch;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); });
      }

      function csvToContacts(text) {
        var rows = parseCsv(text);
        if (!rows.length) return [];
        var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
        function findIdx() {
          var preds = Array.prototype.slice.call(arguments);
          for (var i = 0; i < header.length; i++) {
            for (var p = 0; p < preds.length; p++) { if (header[i].indexOf(preds[p]) !== -1) return i; }
          }
          return -1;
        }
        var hasHeader = findIdx('name', 'phone', 'mobile', 'number', 'company', 'first') !== -1;
        var nameIdx, phoneIdx, companyIdx, firstIdx, lastIdx, startRow;
        if (hasHeader) {
          startRow = 1;
          nameIdx = findIdx('full name', 'display name', 'contact name');
          if (nameIdx === -1) nameIdx = header.indexOf('name');
          firstIdx = findIdx('first name', 'given name');
          lastIdx = findIdx('last name', 'family name', 'surname');
          phoneIdx = findIdx('mobile', 'phone', 'number', 'telephone', 'cell');
          companyIdx = findIdx('company', 'organi', 'business');
        } else {
          startRow = 0; nameIdx = 0; phoneIdx = 1; companyIdx = 2; firstIdx = -1; lastIdx = -1;
        }
        var out = [];
        for (var r = startRow; r < rows.length; r++) {
          var cells = rows[r];
          var name = nameIdx !== -1 && cells[nameIdx] ? cells[nameIdx].trim() : '';
          if (!name && firstIdx !== -1) {
            name = ((cells[firstIdx] || '') + ' ' + (lastIdx !== -1 ? (cells[lastIdx] || '') : '')).trim();
          }
          var phone = phoneIdx !== -1 && cells[phoneIdx] ? cells[phoneIdx].trim() : '';
          if (!phone && hasHeader) {
            for (var k = 0; k < header.length; k++) {
              if ((header[k].indexOf('phone') !== -1 || header[k].indexOf('mobile') !== -1) && cells[k] && cells[k].trim()) { phone = cells[k].trim(); break; }
            }
          }
          var company = companyIdx !== -1 && cells[companyIdx] ? cells[companyIdx].trim() : '';
          if (name && phone) out.push({ name: name, phone: phone, company: company || null });
        }
        return out;
      }

      async function runImport(text) {
        var result = document.getElementById('import-result');
        result.classList.remove('error');
        var parsed = [];
        try { parsed = csvToContacts(text); } catch (e) { parsed = []; }
        if (!parsed.length) {
          result.textContent = 'No contacts found -- make sure the CSV has Name and Phone columns.';
          result.classList.add('error');
          return;
        }
        result.textContent = 'Importing ' + parsed.length + ' contacts…';
        try {
          var res = await fetch('/api/contacts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contacts: parsed }),
          });
          if (!res.ok) { result.textContent = 'Import failed (status ' + res.status + ').'; result.classList.add('error'); return; }
          var data = await res.json();
          result.textContent = 'Imported ' + data.imported + ' new, updated ' + data.updated + (data.skipped ? ', skipped ' + data.skipped : '') + '.';
          await loadContacts();
          setListMode('contacts');
        } catch (e) {
          result.textContent = 'Import failed.'; result.classList.add('error');
        }
      }

      document.getElementById('import-run').addEventListener('click', function () {
        var ta = document.getElementById('import-textarea').value.trim();
        if (ta) { runImport(ta); return; }
        var fileInput = document.getElementById('import-file');
        if (fileInput && fileInput.files && fileInput.files[0]) {
          var reader = new FileReader();
          reader.onload = function () { runImport(String(reader.result || '')); };
          reader.readAsText(fileInput.files[0]);
          return;
        }
        var result = document.getElementById('import-result');
        result.textContent = 'Choose a CSV file or paste CSV text first.';
        result.classList.add('error');
      });

      // ---- Audio device pickers (Twilio Voice SDK audio API). Guarded so an unsupported
      // browser or ungranted mic permission just leaves "System default". ----
      function populateAudioDevices() {
        if (!device || !device.audio) return;
        var hint = document.getElementById('audio-hint');
        var micSel = document.getElementById('audio-input-select');
        var spkSel = document.getElementById('audio-output-select');
        try {
          if (micSel && device.audio.availableInputDevices && device.audio.availableInputDevices.size) {
            var micVal = micSel.value;
            micSel.innerHTML = '';
            device.audio.availableInputDevices.forEach(function (i) {
              var o = document.createElement('option');
              o.value = i.deviceId; o.textContent = i.label || 'Microphone';
              micSel.appendChild(o);
            });
            if (micVal) micSel.value = micVal;
          }
          var outSupported = device.audio.isOutputSelectionSupported;
          var testBtn = document.getElementById('audio-test-btn');
          if (spkSel && outSupported && device.audio.availableOutputDevices && device.audio.availableOutputDevices.size) {
            var spkVal = spkSel.value;
            spkSel.disabled = false;
            if (testBtn) testBtn.disabled = false;
            spkSel.innerHTML = '';
            device.audio.availableOutputDevices.forEach(function (i) {
              var o = document.createElement('option');
              o.value = i.deviceId; o.textContent = i.label || 'Speaker';
              spkSel.appendChild(o);
            });
            if (spkVal) spkSel.value = spkVal;
          } else if (spkSel && !outSupported) {
            spkSel.disabled = true;
            if (testBtn) testBtn.disabled = true;
          }
          if (hint) hint.textContent = outSupported
            ? 'Pick which devices this softphone uses.'
            : 'Speaker selection is not supported in this browser; using the system default.';
        } catch (e) {
          // Non-fatal.
        }
      }
      (function wireAudioControls() {
        var micSel = document.getElementById('audio-input-select');
        var spkSel = document.getElementById('audio-output-select');
        var testBtn = document.getElementById('audio-test-btn');
        if (micSel) micSel.addEventListener('change', function () {
          if (device && device.audio && micSel.value) device.audio.setInputDevice(micSel.value).catch(function () {});
        });
        if (spkSel) spkSel.addEventListener('change', function () {
          if (!device || !device.audio || !spkSel.value) return;
          try { device.audio.speakerDevices.set(spkSel.value); device.audio.ringtoneDevices.set(spkSel.value); } catch (e) {}
        });
        if (testBtn) testBtn.addEventListener('click', function () {
          if (device && device.audio && device.audio.speakerDevices) {
            try { device.audio.speakerDevices.test(); } catch (e) {}
          }
        });
      })();

      function setDeviceStatusText(text, registered) {
        var el = document.getElementById('device-status');
        el.textContent = text;
        el.classList.toggle('registered', !!registered);
      }

      function highlightStatusButtons(status) {
        ['available', 'away', 'offline'].forEach(function (s) {
          var btn = document.getElementById('status-' + s + '-btn');
          if (btn) btn.classList.toggle('active', s === status);
        });
        document.getElementById('away-reason-wrap').style.display = status === 'away' ? 'block' : 'none';
        var avatar = document.getElementById('rail-avatar');
        if (avatar) {
          avatar.classList.remove('presence-available', 'presence-away', 'presence-offline');
          if (status) avatar.classList.add('presence-' + status);
        }
      }

      async function setStatus(status, awayReason) {
        var statusEl = document.getElementById('status-save-status');
        var res = await fetch('/api/softphone/presence', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: status, awayReason: awayReason || null }),
        });
        if (res.ok) {
          highlightStatusButtons(status);
          statusEl.textContent = 'Status updated.';
        } else {
          statusEl.textContent = 'Failed to update status.';
        }
      }

      async function loadInitialStatus() {
        try {
          var res = await fetch('/api/staff');
          if (!res.ok) return;
          var roster = await res.json();
          var me = roster.filter(function (s) { return s.email === STAFF_EMAIL; })[0];
          if (me) highlightStatusButtons(me.status);
        } catch (e) {
          // Non-fatal.
        }
      }

      document.getElementById('status-available-btn').addEventListener('click', function () { setStatus('available', null); });
      document.getElementById('status-offline-btn').addEventListener('click', function () { setStatus('offline', null); });
      document.getElementById('status-away-btn').addEventListener('click', function () {
        highlightStatusButtons('away');
        document.getElementById('away-reason-input').focus();
      });
      document.getElementById('away-reason-save-btn').addEventListener('click', function () {
        var reason = document.getElementById('away-reason-input').value.trim();
        setStatus('away', reason || null);
      });

      document.querySelectorAll('.dialpad-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var digit = btn.getAttribute('data-digit');
          var input = document.getElementById('dial-input');
          input.value += digit;
          if (activeCall) activeCall.sendDigits(digit);
        });
      });
      document.getElementById('dial-backspace-btn').addEventListener('click', function () {
        var input = document.getElementById('dial-input');
        input.value = input.value.slice(0, -1);
      });

      function showIncomingBanner(call) {
        var from = (call.parameters && call.parameters.From) || 'Unknown';
        var contact = contactsByNorm[normalizePhoneJS(from)];
        document.getElementById('incoming-caller').textContent = contact ? contact.name : from;
        document.getElementById('incoming-banner').style.display = 'block';
      }
      function hideIncomingBanner() {
        document.getElementById('incoming-banner').style.display = 'none';
      }

      async function populateTransferTargets() {
        var select = document.getElementById('transfer-target-select');
        select.innerHTML = '<option value="">Choose staff…</option>';
        try {
          var res = await fetch('/api/staff');
          if (!res.ok) return;
          var roster = await res.json();
          roster
            .filter(function (s) { return s.email !== STAFF_EMAIL; })
            .forEach(function (s) {
              var opt = document.createElement('option');
              opt.value = s.email;
              opt.textContent = s.email + ' (' + s.status + ')';
              select.appendChild(opt);
            });
        } catch (e) {
          // Non-fatal.
        }
      }

      function onCallConnected(call) {
        hideIncomingBanner();
        isOnHold = false;
        var peer = (call.parameters && (call.parameters.From || call.parameters.To)) || document.getElementById('dial-input').value || 'call';
        document.getElementById('active-call-peer').textContent = peer;
        document.getElementById('mute-btn').textContent = 'Mute';
        document.getElementById('hold-btn').textContent = 'Hold';
        document.getElementById('complete-transfer-btn').style.display = 'none';
        document.getElementById('transfer-status').textContent = '';
        document.getElementById('active-call-controls').style.display = 'block';
        showDetail('active');
        populateTransferTargets();
      }

      function onCallEnded() {
        hideIncomingBanner();
        document.getElementById('active-call-controls').style.display = 'none';
        showDetail('empty');
        activeCall = null;
        isOnHold = false;
        // The just-ended call now exists in history -- refresh the list shortly after.
        setTimeout(loadCalls, 1500);
      }

      async function placeCall(to) {
        if (!device || !to) return;
        activeCall = await device.connect({ params: { To: to } });
        activeCall.on('accept', onCallConnected);
        activeCall.on('disconnect', onCallEnded);
        activeCall.on('cancel', onCallEnded);
        activeCall.on('reject', onCallEnded);
      }

      document.getElementById('call-btn').addEventListener('click', function () {
        var to = document.getElementById('dial-input').value.trim();
        if (to) placeCall(to).catch(function (err) {
          setDeviceStatusText('Call failed: ' + describeError(err));
        });
      });

      document.getElementById('accept-btn').addEventListener('click', function () {
        if (activeCall) activeCall.accept();
      });
      document.getElementById('reject-btn').addEventListener('click', function () {
        if (activeCall) activeCall.reject();
        hideIncomingBanner();
        activeCall = null;
      });

      document.getElementById('mute-btn').addEventListener('click', function () {
        if (!activeCall) return;
        var muted = activeCall.isMuted();
        activeCall.mute(!muted);
        document.getElementById('mute-btn').textContent = muted ? 'Mute' : 'Unmute';
      });

      // Both hold and transfer/complete key off the agent's own browser-leg CallSid, which
      // doubles as the Twilio Conference's friendly name for the call this agent is on (the
      // TwiML side names the conference after this exact leg -- see worker.ts's /twiml/voice-app
      // and CallSession.ts's handleAgentAnswer, both of which set conferenceName = the agent
      // leg's own CallSid).
      document.getElementById('hold-btn').addEventListener('click', async function () {
        if (!activeCall || !activeCall.parameters || !activeCall.parameters.CallSid) return;
        var callSid = activeCall.parameters.CallSid;
        var nextHold = !isOnHold;
        var res = await fetch('/api/softphone/hold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conferenceName: callSid, selfCallSid: callSid, hold: nextHold }),
        });
        if (res.ok) {
          isOnHold = nextHold;
          document.getElementById('hold-btn').textContent = isOnHold ? 'Resume' : 'Hold';
        }
      });

      document.getElementById('hangup-btn').addEventListener('click', function () {
        if (activeCall) activeCall.disconnect();
      });

      document.getElementById('transfer-btn').addEventListener('click', async function () {
        var status = document.getElementById('transfer-status');
        if (!activeCall || !activeCall.parameters || !activeCall.parameters.CallSid) return;
        var target = document.getElementById('transfer-target-select').value;
        if (!target) {
          status.textContent = 'Choose a staff member first.';
          return;
        }
        var callSid = activeCall.parameters.CallSid;
        var res = await fetch('/api/softphone/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conferenceName: callSid, targetEmail: target, agentCallSid: callSid }),
        });
        if (res.ok) {
          status.textContent = 'Transfer to ' + target + ' started. Once they join, click "Complete transfer".';
          document.getElementById('complete-transfer-btn').style.display = 'inline-block';
        } else {
          status.textContent = 'Transfer failed.';
        }
      });

      document.getElementById('complete-transfer-btn').addEventListener('click', async function () {
        var status = document.getElementById('transfer-status');
        if (!activeCall || !activeCall.parameters || !activeCall.parameters.CallSid) return;
        var callSid = activeCall.parameters.CallSid;
        var res = await fetch('/api/softphone/transfer/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conferenceName: callSid, callSid: callSid, selfCallSid: callSid }),
        });
        if (res.ok) {
          status.textContent = 'Transfer complete -- you have left the call.';
          document.getElementById('complete-transfer-btn').style.display = 'none';
          activeCall.disconnect();
        } else {
          status.textContent = 'Failed to complete transfer.';
        }
      });

      // Full detail for TwilioErrors: "AccessTokenInvalid (20101): ..." instead of "undefined".
      function describeError(err) {
        if (!err) return 'unknown error';
        var msg = err.message || String(err);
        if (err.code && msg.indexOf('(' + err.code + ')') === -1) msg = msg + ' (code ' + err.code + ')';
        return msg;
      }

      // A lapsed Cloudflare Access session turns same-origin API fetches into cross-origin
      // redirects to cloudflareaccess.com, which reject with TypeError before any status check
      // runs. Reloading the page re-triggers the Access login.
      function sessionExpiredHint() {
        setDeviceStatusText('Session expired -- reload (Ctrl+Shift+R) to sign back in.');
      }

      async function initDevice() {
        setDeviceStatusText('Registering…');
        try {
          var res = await fetch('/api/softphone/token');
          if (!res.ok) {
            setDeviceStatusText('No access token (status ' + res.status + ').');
            return;
          }
          var data = await res.json();
          device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], edge: 'sydney' });
          if (device.audio && device.audio.on) device.audio.on('deviceChange', populateAudioDevices);
          device.on('registered', function () {
            setDeviceStatusText('Registered', true);
            populateAudioDevices();
          });
          device.on('unregistered', function () {
            var el = document.getElementById('device-status');
            if (el && el.textContent.indexOf('Device error') === 0) return;
            setDeviceStatusText('Unregistered');
          });
          device.on('error', function (err) {
            setDeviceStatusText('Device error: ' + describeError(err));
          });
          device.on('tokenWillExpire', async function () {
            try {
              var r = await fetch('/api/softphone/token');
              if (!r.ok) {
                setDeviceStatusText('Could not refresh token (status ' + r.status + ').');
                return;
              }
              var d = await r.json();
              device.updateToken(d.token);
            } catch (e) {
              sessionExpiredHint();
            }
          });
          device.on('incoming', function (call) {
            activeCall = call;
            showIncomingBanner(call);
            window.desktopBridge?.notifyIncomingCall(call.parameters && call.parameters.From);
            call.on('accept', onCallConnected);
            call.on('disconnect', onCallEnded);
            call.on('cancel', onCallEnded);
            call.on('reject', onCallEnded);
          });
          await device.register();
        } catch (err) {
          if (err !== undefined) setDeviceStatusText('Registration failed: ' + describeError(err));
        }
      }

      // Heartbeat: keep presence alive while this tab is open. Two consecutive failures means
      // the Access session has lapsed (or the network is down) -- surface it.
      var heartbeatFailures = 0;
      function sendHeartbeat() {
        fetch('/api/softphone/heartbeat', { method: 'POST' })
          .then(function (r) {
            if (r.ok) { heartbeatFailures = 0; return; }
            if (++heartbeatFailures >= 2) setDeviceStatusText('Heartbeat failing (status ' + r.status + ').');
          })
          .catch(function () {
            if (++heartbeatFailures >= 2) sessionExpiredHint();
          });
      }
      setInterval(sendHeartbeat, 20000);
      sendHeartbeat();

      loadInitialStatus();
      loadCalls();
      loadContacts();
      setInterval(loadCalls, 30000);
      if (window.Twilio) {
        initDevice();
      } else {
        document.getElementById('sdk-error').style.display = 'block';
        setDeviceStatusText('Twilio Voice SDK unavailable.');
      }
    </script>`;

  return renderLayout("Phone", "phone", body, { extraHead: extraHead, fullWidth: true, role });
}

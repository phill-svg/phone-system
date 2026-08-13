import { renderLayout, escapeHtml } from "../layout";

// Embeds a value as a JSON literal inside a <script> block. Guards against a stray
// "</script>" breaking out of the script tag early (same helper as ivrFlow.ts).
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Version resolved live from `https://registry.npmjs.org/@twilio/voice-sdk`'s dist-tags.latest
// at the time this file was written (2026-08-12) -- NOT the version this task's plan guessed.
// The plan's guessed URL (sdk.twilio.com/js/voice/releases/2.11.0/twilio.min.js) is dead: as of
// v2.0 the Voice SDK is no longer hosted on Twilio's own CDN (confirmed both by the package's
// README, which states this explicitly, and empirically -- that URL 403s). Instead this mirrors
// the exact pattern already established for Drawflow in ivrFlow.ts: pull the npm package's own
// UMD bundle off jsdelivr. Verified by downloading dist/twilio.min.js from this exact URL and
// confirming it ends by assigning `root.Twilio.Device`/`.Call`/etc. -- the same global surface
// (`new Twilio.Device(...)`) this page's core wiring below depends on.
const TWILIO_VOICE_SDK_VERSION = "2.18.3";
const TWILIO_SDK_JS_URL = `https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@${TWILIO_VOICE_SDK_VERSION}/dist/twilio.min.js`;

// Small hand-written inline SVG icons (no icon font/CDN dependency -- matches this project's
// existing convention of vendoring only the one library a page actually needs, e.g. Drawflow
// for ivrFlow.ts). Kept tiny and monochrome; colour is applied via each icon's own `stroke`/
// `fill` attribute rather than currentColor, since a couple of these are used inside CSS
// background-image data URIs (see mute/hold buttons below) where currentColor doesn't resolve.
const ICON_PHONE = `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M4.4 2.6c.4-.3.9-.3 1.2 0l2 1.7c.3.3.4.7.2 1.1l-1 2c-.1.3-.1.6.1.8l4 4c.2.2.5.2.8.1l2-1c.4-.2.8-.1 1.1.2l1.7 2c.3.3.3.8 0 1.2l-1 .9c-1 .9-2.5 1.1-3.7.5-3.4-1.7-6.2-4.5-7.9-7.9-.6-1.2-.4-2.7.5-3.7l.9-1z"/></svg>`;
const ICON_BACKSPACE = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4h8a1 1 0 011 1v10a1 1 0 01-1 1h-8l-4-6 4-6z"/><path d="M9.7 8.2l3.6 3.6M13.3 8.2l-3.6 3.6"/></svg>`;
const ICON_CHECK_CIRCLE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M6.5 10.3l2.3 2.3 4.7-5.6"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 6v4l3 2"/></svg>`;
const ICON_SLASH_CIRCLE = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="8"/><path d="M5 15L15 5"/></svg>`;
const ICON_KEYPAD = `<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><circle cx="5" cy="5" r="1.6"/><circle cx="10" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15" cy="10" r="1.6"/><circle cx="5" cy="15" r="1.6"/><circle cx="10" cy="15" r="1.6"/><circle cx="15" cy="15" r="1.6"/></svg>`;
const ICON_TRANSFER = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11l-3-3M17 13H6l3 3"/></svg>`;
const ICON_SETTINGS = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2.2M10 15v2.2M17.2 10H15M5 10H2.8M14.9 5.1l-1.6 1.6M6.7 13.3l-1.6 1.6M14.9 14.9l-1.6-1.6M6.7 6.7L5.1 5.1"/></svg>`;

export function renderPhonePage(staffEmail: string): string {
  const staffInitials = escapeHtml((staffEmail.split("@")[0] || "?").slice(0, 2).toUpperCase());
  const staffEmailSafe = escapeHtml(staffEmail);

  const extraHead = `<style>
      :root {
        --phone-bg: #f3f5f4;
        --phone-rail-bg: #1a3d2e;
        --phone-panel: #ffffff;
        --phone-card: #f8faf8;
        --phone-card-hover: #edf3ef;
        --phone-border: #cfe0d7;
        --phone-text: #10231b;
        --phone-text-dim: #4b645b;
        --phone-text-mute: #6e8078;
        --phone-green: #1a3d2e;
        --phone-green-hover: #123127;
        --phone-green-dim: #dfece6;
        --phone-red: #b63d3d;
        --phone-red-dim: #f8e1e1;
        --phone-orange-dim: #f9ebdb;
        --phone-orange: #c97c2b;
      }
      .phone-app { display: flex; min-height: calc(100vh - 64px); background: var(--phone-bg); color: var(--phone-text); font-family: system-ui, sans-serif; }
      #sdk-error { display: none; margin: 1rem 1.25rem 0; padding: 0.7rem 1rem; background: var(--phone-red-dim); color: var(--phone-red); border-radius: 0.5rem; font-size: 0.85rem; }

      /* Icon rail -- adapted from Aircall's Conversations/Calls/Messages/.../Evaluations rail,
         narrowed to the sections this page actually has: status, dial pad, active call. */
      .phone-rail { width: 84px; flex-shrink: 0; background: var(--phone-rail-bg); border-right: 1px solid var(--phone-border); display: flex; flex-direction: column; align-items: center; padding: 1rem 0; }
      .phone-rail-item { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; color: var(--phone-text-dim); text-decoration: none; padding: 0.6rem 0.4rem; border-radius: 0.6rem; width: 68px; font-size: 0.66rem; margin-bottom: 0.4rem; }
      .phone-rail-item:hover { background: rgba(255,255,255,0.06); color: var(--phone-text); }
      .phone-rail-item svg { display: block; }
      .phone-rail-spacer { flex: 1; }
      .phone-rail-avatar { width: 36px; height: 36px; border-radius: 50%; background: #3b3d63; color: white; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 600; margin-bottom: 0.75rem; letter-spacing: 0.02em; }
      .phone-rail-settings { color: var(--phone-text-mute); }

      .phone-main { flex: 1; padding: 1.5rem 1.75rem 2.5rem; max-width: 640px; }

      .device-status-pill { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--phone-text-dim); background: var(--phone-panel); border: 1px solid var(--phone-border); border-radius: 999px; padding: 0.35rem 0.9rem 0.35rem 0.6rem; margin-bottom: 1.5rem; }
      .device-status-pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--phone-text-mute); flex-shrink: 0; }
      .device-status-pill.registered { color: var(--phone-green); }
      .device-status-pill.registered::before { background: var(--phone-green); box-shadow: 0 0 0 3px rgba(0,197,142,0.2); }

      .phone-card { background: var(--phone-card); border: 1px solid var(--phone-border); border-radius: 0.9rem; padding: 1.1rem 1.25rem 1.25rem; margin-bottom: 1.25rem; }
      .phone-card-title { margin: 0 0 0.9rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--phone-text-dim); }
      /* JS toggles this element's own style.display between "block" and "none" (unchanged
         from the page's original behaviour) -- hidden by default until a call connects. */
      #active-call-controls { display: none; }

      /* Status menu -- Aircall's presence list: coloured icon badge + label per state, not a
         plain radio/checkbox row. */
      .status-menu { display: flex; flex-direction: column; gap: 0.3rem; }
      .status-option { display: flex; align-items: center; gap: 0.7rem; width: 100%; text-align: left; background: none; border: 1px solid transparent; border-radius: 0.6rem; padding: 0.5rem 0.6rem; cursor: pointer; color: var(--phone-text); font-size: 0.88rem; }
      .status-option:hover { background: var(--phone-card-hover); }
      .status-option.active { background: var(--phone-card-hover); border-color: var(--phone-border); }
      .status-icon { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .status-icon-available { background: var(--phone-green-dim); color: var(--phone-green); }
      .status-icon-away { background: var(--phone-orange-dim); color: var(--phone-orange); }
      .status-icon-offline { background: var(--phone-red-dim); color: var(--phone-red); }
      .status-option-check { margin-left: auto; color: var(--phone-green); display: none; }
      .status-option.active .status-option-check { display: flex; }

      /* JS toggles this wrapper's own style.display between "block" and "none" (unchanged
         from the page's original behaviour) -- the flex row lives on the inner element so the
         outer element can stay display:block/none without fighting that inline style. */
      #away-reason-wrap { display: none; margin: 0.6rem 0 0.2rem; padding: 0.7rem 0.6rem 0.2rem; border-top: 1px solid var(--phone-border); }
      .away-reason-row { display: flex; gap: 0.5rem; }
      .phone-input { font-size: 0.85rem; padding: 0.5rem 0.7rem; background: var(--phone-panel); border: 1px solid var(--phone-border); border-radius: 0.5rem; color: var(--phone-text); box-sizing: border-box; }
      .phone-input::placeholder { color: var(--phone-text-mute); }
      .away-reason-row .phone-input { flex: 1; }
      .status-save-line { min-height: 1.1rem; margin: 0.5rem 0 0; font-size: 0.75rem; color: var(--phone-text-dim); }

      /* Pill buttons */
      .pill-btn { display: inline-flex; align-items: center; gap: 0.45rem; border: none; border-radius: 999px; padding: 0.5rem 1.1rem; font-size: 0.85rem; font-weight: 500; cursor: pointer; }
      .pill-btn-primary, .pill-btn-call { background: var(--phone-green); color: #06251c; }
      .pill-btn-primary:hover, .pill-btn-call:hover { background: var(--phone-green-hover); }
      .pill-btn-secondary { background: var(--phone-panel); color: var(--phone-text); border: 1px solid var(--phone-border); }
      .pill-btn-secondary:hover { background: var(--phone-card-hover); }

      /* Dial pad -- numeric keypad grid, large centred digit + small letters beneath, matching
         Aircall's new-conversation dial pad layout. */
      .dial-label { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--phone-text-mute); margin-bottom: 0.4rem; }
      .dial-input { width: 100%; font-size: 1rem; margin-bottom: 1rem; }
      .keypad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.15rem; max-width: 320px; margin: 0 auto 1.1rem; }
      .keypad-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.15rem; background: none; border: none; border-radius: 0.7rem; padding: 0.7rem 0.4rem; cursor: pointer; color: var(--phone-text); }
      .keypad-btn:hover { background: var(--phone-card-hover); }
      .keypad-digit { font-size: 1.35rem; font-weight: 500; line-height: 1; }
      .keypad-letters { font-size: 0.6rem; letter-spacing: 0.08em; color: var(--phone-text-mute); text-transform: uppercase; min-height: 0.7rem; }
      .keypad-actions { display: flex; align-items: center; justify-content: center; gap: 0.75rem; }
      .icon-btn { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: var(--phone-panel); border: 1px solid var(--phone-border); color: var(--phone-text-dim); cursor: pointer; }
      .icon-btn:hover { background: var(--phone-card-hover); color: var(--phone-text); }

      /* Incoming call banner */
      /* JS toggles #incoming-banner's own style.display between "block" and "none" (unchanged
         from the page's original behaviour); the flex row lives on the inner wrapper. */
      #incoming-banner { display: none; background: var(--phone-card); border: 1px solid var(--phone-orange); border-radius: 0.9rem; padding: 1rem 1.1rem; margin-bottom: 1.25rem; }
      .incoming-banner-row { display: flex; align-items: center; gap: 0.9rem; }
      .incoming-avatar { width: 42px; height: 42px; border-radius: 50%; background: var(--phone-orange-dim); color: var(--phone-orange); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .incoming-info { flex: 1; min-width: 0; }
      .incoming-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--phone-text-dim); }
      .incoming-caller { font-size: 0.95rem; font-weight: 600; word-break: break-word; }
      .incoming-actions { display: flex; gap: 0.6rem; flex-shrink: 0; }
      .round-btn { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer; color: white; }
      .round-btn-accept { background: var(--phone-green); }
      .round-btn-accept:hover { background: var(--phone-green-hover); }
      .round-btn-reject, .round-btn-hangup { background: var(--phone-red); }
      .round-btn-reject:hover, .round-btn-hangup:hover { background: #c73338; }
      .round-btn-reject svg, .round-btn-hangup svg { transform: rotate(135deg); }

      /* Active call controls */
      .call-controls-row { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 0.4rem; }
      .toggle-pill-btn { display: inline-flex; align-items: center; gap: 0.5rem; background: var(--phone-panel); border: 1px solid var(--phone-border); border-radius: 999px; padding: 0.5rem 1rem 0.5rem 0.6rem; color: var(--phone-text); font-size: 0.85rem; cursor: pointer; }
      .toggle-pill-btn:hover { background: var(--phone-card-hover); }
      .toggle-pill-btn::before { content: ""; width: 22px; height: 22px; border-radius: 50%; background-color: rgba(255,255,255,0.08); background-repeat: no-repeat; background-position: center; flex-shrink: 0; }
      #mute-btn::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23e5e7eb' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='7' y='2.6' width='6' height='9' rx='3'/%3E%3Cpath d='M4.5 9.6a5.5 5.5 0 0011 0'/%3E%3Cpath d='M10 15.1v2.3'/%3E%3Cpath d='M7 17.4h6'/%3E%3C/svg%3E"); }
      #hold-btn::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%23e5e7eb'%3E%3Crect x='6' y='4' width='3' height='12' rx='1'/%3E%3Crect x='11' y='4' width='3' height='12' rx='1'/%3E%3C/svg%3E"); }
      #hangup-btn { margin-left: auto; }

      .transfer-panel { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid var(--phone-border); display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
      .phone-select { padding: 0.45rem 0.6rem; border-radius: 0.5rem; background: var(--phone-panel); border: 1px solid var(--phone-border); color: var(--phone-text); font-size: 0.82rem; }
      .transfer-status-line { flex: 0 0 100%; margin: 0.2rem 0 0; font-size: 0.75rem; color: var(--phone-text-dim); }
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
    .join("\n        ");

  const body = `<div class="phone-app">
    <nav class="phone-rail">
      <a class="phone-rail-item" href="#status-control" title="Your status">${ICON_CHECK_CIRCLE.replace('width="14" height="14"', 'width="18" height="18"')}<span>Status</span></a>
      <a class="phone-rail-item" href="#dialpad-card" title="Dial pad">${ICON_KEYPAD}<span>Dial</span></a>
      <a class="phone-rail-item" href="#active-call-controls" title="Active call">${ICON_PHONE}<span>Call</span></a>
      <div class="phone-rail-spacer"></div>
      <div class="phone-rail-avatar" title="${staffEmailSafe}">${staffInitials}</div>
      <a class="phone-rail-item phone-rail-settings" href="/admin/settings" title="Settings">${ICON_SETTINGS}<span>Settings</span></a>
    </nav>

    <div class="phone-main">
      <div id="sdk-error">Could not load the Twilio Voice SDK. Check your connection and reload the page.</div>
      <div id="device-status" class="device-status-pill">Initializing softphone…</div>

      <section class="phone-card" id="status-control">
        <h3 class="phone-card-title">Your status</h3>
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
      </section>

      <section class="phone-card" id="dialpad-card">
        <h3 class="phone-card-title">Dial pad</h3>
        <span class="dial-label">To</span>
        <input type="text" id="dial-input" class="phone-input dial-input" placeholder="Phone number or extension">
        <div id="dialpad-grid" class="keypad-grid">
        ${keypadHtml}
        </div>
        <div class="keypad-actions">
          <button type="button" id="call-btn" class="pill-btn pill-btn-call">${ICON_PHONE}<span>Call</span></button>
          <button type="button" id="dial-backspace-btn" class="icon-btn" title="Backspace">${ICON_BACKSPACE}</button>
        </div>
      </section>

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

      <section class="phone-card" id="active-call-controls">
        <h3 class="phone-card-title">On call with <span id="active-call-peer"></span></h3>
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
    </div>
    </div>

    <script src="${TWILIO_SDK_JS_URL}" onerror="document.getElementById('sdk-error').style.display='block'"></script>
    <script>
      var STAFF_EMAIL = ${safeJsonForScript(staffEmail)};
      var device = null;
      var activeCall = null;
      var isOnHold = false;

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
          // Non-fatal -- the status buttons just start with none highlighted.
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
        document.getElementById('incoming-caller').textContent = from;
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
          // Non-fatal -- transfer picker just stays empty.
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
        populateTransferTargets();
      }

      function onCallEnded() {
        hideIncomingBanner();
        document.getElementById('active-call-controls').style.display = 'none';
        activeCall = null;
        isOnHold = false;
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

      // Full detail for TwilioErrors: "AccessTokenInvalid (20101): Twilio was unable to
      // validate your Access Token" instead of just the message (or, worse, "undefined").
      function describeError(err) {
        if (!err) return 'unknown error';
        var msg = err.message || String(err);
        if (err.code && msg.indexOf('(' + err.code + ')') === -1) msg = msg + ' (code ' + err.code + ')';
        return msg;
      }

      // A lapsed Cloudflare Access session turns same-origin API fetches into cross-origin
      // redirects to cloudflareaccess.com, which reject with TypeError before any status
      // check runs. Reloading the page re-triggers the Access login.
      function sessionExpiredHint() {
        setDeviceStatusText('Signed-in session expired -- reload this page (Ctrl+Shift+R) to sign back in.');
      }

      async function initDevice() {
        setDeviceStatusText('Registering…');
        try {
          var res = await fetch('/api/softphone/token');
          if (!res.ok) {
            setDeviceStatusText('Could not fetch an access token (status ' + res.status + ').');
            return;
          }
          var data = await res.json();
          device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], edge: 'sydney' });
          device.on('registered', function () { setDeviceStatusText('Registered -- ready to receive calls.', true); });
          device.on('unregistered', function () {
            // Registration failure fires 'error' then 'unregistered' -- keep the
            // informative error on screen rather than replacing it with this.
            var el = document.getElementById('device-status');
            if (el && el.textContent.indexOf('Device error') === 0) return;
            setDeviceStatusText('Unregistered.');
          });
          device.on('error', function (err) {
            setDeviceStatusText('Device error: ' + describeError(err));
          });
          device.on('tokenWillExpire', async function () {
            try {
              var r = await fetch('/api/softphone/token');
              if (!r.ok) {
                setDeviceStatusText('Could not refresh the access token (status ' + r.status + ').');
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
          // The SDK's register() rejects with NO argument when registration fails via a
          // device 'error' event -- the handler above has already shown the real error,
          // so only overwrite the status when we actually have something to say.
          if (err !== undefined) setDeviceStatusText('Registration failed: ' + describeError(err));
        }
      }

      // Heartbeat: keep presence alive while this tab is open (HEARTBEAT_STALE_MS is 5
      // minutes; ping well under that). Two consecutive failures means the Access session
      // has lapsed (or the network is down) -- surface it instead of silently going stale
      // in the ring roster while the pill still says "Registered".
      var heartbeatFailures = 0;
      function sendHeartbeat() {
        fetch('/api/softphone/heartbeat', { method: 'POST' })
          .then(function (r) {
            if (r.ok) { heartbeatFailures = 0; return; }
            if (++heartbeatFailures >= 2) setDeviceStatusText('Presence heartbeat failing (status ' + r.status + ') -- you may not receive calls.');
          })
          .catch(function () {
            if (++heartbeatFailures >= 2) sessionExpiredHint();
          });
      }
      setInterval(sendHeartbeat, 20000);
      sendHeartbeat();

      loadInitialStatus();
      if (window.Twilio) {
        initDevice();
      } else {
        document.getElementById('sdk-error').style.display = 'block';
        setDeviceStatusText('Twilio Voice SDK unavailable.');
      }
    </script>`;

  return renderLayout("Phone", "phone", body, { extraHead: extraHead, fullWidth: true });
}

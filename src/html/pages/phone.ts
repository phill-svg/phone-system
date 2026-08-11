import { renderLayout } from "../layout";

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

export function renderPhonePage(staffEmail: string): string {
  const extraHead = `<style>
      #sdk-error, #device-error { display: none; padding: 0.75rem 1rem; background: #fde8e8; color: #9b1c1c; border-radius: 0.4rem; margin-bottom: 1rem; }
      #device-status { font-size: 0.85rem; color: #6b7280; margin-bottom: 1.5rem; }
      #device-status.registered { color: #1a7d3f; }
      .phone-panel { border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
      .phone-panel h3 { margin-top: 0; font-size: 0.95rem; }
      #status-control button { padding: 0.4rem 0.9rem; border: 1px solid #d1d5db; background: white; border-radius: 999px; cursor: pointer; margin-right: 0.5rem; font-size: 0.85rem; }
      #status-control button.active { background: #1a3d2e; color: white; border-color: #1a3d2e; }
      #away-reason-wrap { display: none; margin-top: 0.6rem; }
      #away-reason-wrap input { padding: 0.3rem 0.5rem; border: 1px solid #d1d5db; border-radius: 0.3rem; margin-right: 0.4rem; }
      #dial-input { font-size: 1.1rem; padding: 0.5rem; width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 0.4rem; margin-bottom: 0.75rem; }
      #dialpad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; max-width: 280px; margin-bottom: 0.75rem; }
      .dialpad-btn { padding: 0.7rem; font-size: 1.05rem; border: 1px solid #d1d5db; background: #f9fafb; border-radius: 0.4rem; cursor: pointer; }
      #call-btn { background: #1a7d3f; color: white; border: none; border-radius: 0.4rem; padding: 0.55rem 1.4rem; cursor: pointer; font-size: 0.9rem; }
      #dial-backspace-btn { background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 0.4rem; padding: 0.5rem 0.9rem; cursor: pointer; margin-left: 0.5rem; }
      #incoming-banner { display: none; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.25rem; }
      #incoming-banner button { margin-right: 0.5rem; padding: 0.4rem 1rem; border-radius: 0.4rem; border: none; cursor: pointer; }
      #accept-btn { background: #1a7d3f; color: white; }
      #reject-btn { background: #b91c1c; color: white; }
      #active-call-controls { display: none; }
      #active-call-controls button { margin-right: 0.5rem; padding: 0.4rem 0.9rem; border-radius: 0.4rem; border: 1px solid #d1d5db; background: white; cursor: pointer; }
      #hangup-btn { background: #b91c1c; color: white; border: none; }
      #transfer-panel { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #e5e7eb; }
      #transfer-panel select { padding: 0.35rem; border-radius: 0.3rem; border: 1px solid #d1d5db; margin-right: 0.5rem; }
    </style>`;

  const body = `<div id="sdk-error">Could not load the Twilio Voice SDK. Check your connection and reload the page.</div>
    <div id="device-status">Initializing softphone…</div>

    <div class="phone-panel" id="status-control">
      <h3>Your status</h3>
      <button type="button" id="status-available-btn" data-status="available">Available</button>
      <button type="button" id="status-away-btn" data-status="away">Away</button>
      <button type="button" id="status-offline-btn" data-status="offline">Offline</button>
      <div id="away-reason-wrap">
        <input type="text" id="away-reason-input" placeholder="Reason (optional)">
        <button type="button" id="away-reason-save-btn">Set Away</button>
      </div>
      <p><span id="status-save-status"></span></p>
    </div>

    <div class="phone-panel">
      <h3>Dial pad</h3>
      <input type="text" id="dial-input" placeholder="Phone number or extension">
      <div id="dialpad-grid">
        <button type="button" class="dialpad-btn" data-digit="1">1</button>
        <button type="button" class="dialpad-btn" data-digit="2">2</button>
        <button type="button" class="dialpad-btn" data-digit="3">3</button>
        <button type="button" class="dialpad-btn" data-digit="4">4</button>
        <button type="button" class="dialpad-btn" data-digit="5">5</button>
        <button type="button" class="dialpad-btn" data-digit="6">6</button>
        <button type="button" class="dialpad-btn" data-digit="7">7</button>
        <button type="button" class="dialpad-btn" data-digit="8">8</button>
        <button type="button" class="dialpad-btn" data-digit="9">9</button>
        <button type="button" class="dialpad-btn" data-digit="*">*</button>
        <button type="button" class="dialpad-btn" data-digit="0">0</button>
        <button type="button" class="dialpad-btn" data-digit="#">#</button>
      </div>
      <button type="button" id="call-btn">Call</button>
      <button type="button" id="dial-backspace-btn">⌫</button>
    </div>

    <div id="incoming-banner">
      <p>Incoming call from <strong id="incoming-caller"></strong></p>
      <button type="button" id="accept-btn">Accept</button>
      <button type="button" id="reject-btn">Reject</button>
    </div>

    <div class="phone-panel" id="active-call-controls">
      <h3>On call with <span id="active-call-peer"></span></h3>
      <button type="button" id="mute-btn">Mute</button>
      <button type="button" id="hold-btn">Hold</button>
      <button type="button" id="hangup-btn">Hang up</button>
      <div id="transfer-panel">
        <select id="transfer-target-select"><option value="">Choose staff…</option></select>
        <button type="button" id="transfer-btn">Transfer</button>
        <button type="button" id="complete-transfer-btn" style="display:none;">Complete transfer</button>
        <p><span id="transfer-status"></span></p>
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

      function placeCall(to) {
        if (!device || !to) return;
        activeCall = device.connect({ params: { To: to } });
        activeCall.on('accept', onCallConnected);
        activeCall.on('disconnect', onCallEnded);
        activeCall.on('cancel', onCallEnded);
        activeCall.on('reject', onCallEnded);
      }

      document.getElementById('call-btn').addEventListener('click', function () {
        var to = document.getElementById('dial-input').value.trim();
        if (to) placeCall(to);
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
          body: JSON.stringify({ conferenceName: callSid, targetEmail: target }),
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
          body: JSON.stringify({ conferenceName: callSid, callSid: callSid }),
        });
        if (res.ok) {
          status.textContent = 'Transfer complete -- you have left the call.';
          document.getElementById('complete-transfer-btn').style.display = 'none';
          activeCall.disconnect();
        } else {
          status.textContent = 'Failed to complete transfer.';
        }
      });

      async function initDevice() {
        setDeviceStatusText('Registering…');
        try {
          var res = await fetch('/api/softphone/token');
          if (!res.ok) {
            setDeviceStatusText('Could not fetch an access token (status ' + res.status + ').');
            return;
          }
          var data = await res.json();
          device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'] });
          device.on('registered', function () { setDeviceStatusText('Registered -- ready to receive calls.', true); });
          device.on('unregistered', function () { setDeviceStatusText('Unregistered.'); });
          device.on('error', function (err) {
            setDeviceStatusText('Device error: ' + (err && err.message ? err.message : err));
          });
          device.on('tokenWillExpire', async function () {
            var r = await fetch('/api/softphone/token');
            if (r.ok) {
              var d = await r.json();
              device.updateToken(d.token);
            }
          });
          device.on('incoming', function (call) {
            activeCall = call;
            showIncomingBanner(call);
            call.on('accept', onCallConnected);
            call.on('disconnect', onCallEnded);
            call.on('cancel', onCallEnded);
            call.on('reject', onCallEnded);
          });
          await device.register();
        } catch (err) {
          setDeviceStatusText('Registration failed: ' + (err && err.message ? err.message : err));
        }
      }

      // Heartbeat: keep presence alive while this tab is open (Task 1's HEARTBEAT_STALE_MS is
      // 60s; ping well under that).
      setInterval(function () { fetch('/api/softphone/heartbeat', { method: 'POST' }); }, 20000);
      fetch('/api/softphone/heartbeat', { method: 'POST' });

      loadInitialStatus();
      if (window.Twilio) {
        initDevice();
      } else {
        document.getElementById('sdk-error').style.display = 'block';
        setDeviceStatusText('Twilio Voice SDK unavailable.');
      }
    </script>`;

  return renderLayout("Phone", "phone", body, { extraHead: extraHead });
}

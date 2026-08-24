import { escapeHtml, renderLayout } from "../layout";
import type { BusinessHoursSchedule } from "../../ivr/businessHours";
import type { StaffPresenceRow } from "../../dial/presence";

const DAYS: (keyof BusinessHoursSchedule)[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS: Record<string, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

// Turns an arbitrary string (a DOM id fragment, e.g. an email address) into something safe to
// splice into both an `id="..."` attribute and a single-quoted `document.getElementById('...')`
// call embedded in an inline event handler.
function domIdSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

// Renders the day-checkbox/time-input rows shared by the business-hours form and each staff
// member's schedule form. `idPrefix` keeps each form's `<span id="...">` targets unique on the
// page (the checkboxes' inline `onchange` handlers look them up via `getElementById`), while the
// `name` attributes stay bare day keys since `scheduleFromForm` below reads them scoped to their
// own `<form>`.
function renderDayRows(schedule: BusinessHoursSchedule, idPrefix: string): string {
  return DAYS.map((day) => {
    const window = schedule[day];
    const timesId = `${idPrefix}-${day}-times`;
    return `<label>
      <input type="checkbox" name="${day}-open" ${window ? "checked" : ""} onchange="document.getElementById('${timesId}').style.display = this.checked ? 'inline' : 'none'">
      ${DAY_LABELS[day]}
      <span id="${timesId}" style="display:${window ? "inline" : "none"}">
        <input type="time" name="${day}-start" value="${escapeHtml(window?.open ?? "07:00")}">
        to
        <input type="time" name="${day}-end" value="${escapeHtml(window?.close ?? "17:00")}">
      </span>
    </label>`;
  }).join("");
}

function renderStaffAccess(
  staffAccess: { email: string; role: string; hasPassword: boolean }[]
): string {
  const rows = staffAccess
    .map((s) => {
      const status = s.hasPassword
        ? '<span class="badge">Active</span>'
        : '<span class="badge badge-after-hours">Invited</span>';
      const e = escapeHtml(s.email);
      return `<tr data-email="${e}">
        <td>${e}</td><td>${escapeHtml(s.role)}</td><td>${status}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="staff-reset">Send reset</button>
          <button type="button" class="staff-resend">Resend invite</button>
          <button type="button" class="staff-remove">Remove</button>
        </td></tr>`;
    })
    .join("");

  return `<form class="settings-form" onsubmit="return false">
    <h3>Staff access</h3>
    <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.9rem;flex-wrap:wrap;">
      <input id="invite-email" type="email" placeholder="name@anyemail.com — any address you invite" style="flex:1;min-width:220px;">
      <select id="invite-role"><option value="staff">Staff</option><option value="admin">Admin</option></select>
      <button type="button" id="staff-invite-btn">Invite</button>
    </div>
    <table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p id="staff-msg" class="placeholder" style="display:none;"></p>
    <script>
      function staffMsg(t){var el=document.getElementById('staff-msg');el.textContent=t;el.style.display='block';}
      async function inviteStaff(){
        var email=document.getElementById('invite-email').value.trim();
        var role=document.getElementById('invite-role').value;
        if(!email)return staffMsg('Enter an email.');
        var r=await fetch('/api/staff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,role:role})});
        var d=await r.json().catch(function(){return {};});
        if(r.ok){location.reload();}else{staffMsg((d.error||'Invite failed.')+(d.detail?(' — '+d.detail):''));}
      }
      async function staffAction(email,kind){
        var r=await fetch('/api/staff/'+encodeURIComponent(email)+'/'+kind,{method:'POST'});
        var d=await r.json().catch(function(){return {};});
        staffMsg(r.ok?(kind==='reset'?'Reset link sent.':'Invite resent.'):(d.error||'Failed.'));
      }
      async function staffRemove(email){
        if(!confirm('Remove '+email+'?'))return;
        var r=await fetch('/api/staff/'+encodeURIComponent(email),{method:'DELETE'});
        var d=await r.json().catch(function(){return {};});
        if(r.ok){location.reload();}else{staffMsg(d.error||'Remove failed.');}
      }
      document.getElementById('staff-invite-btn').addEventListener('click', inviteStaff);
      document.querySelectorAll('.staff-reset').forEach(function(b){ b.addEventListener('click', function(){ staffAction(b.closest('tr').dataset.email, 'reset'); }); });
      document.querySelectorAll('.staff-resend').forEach(function(b){ b.addEventListener('click', function(){ staffAction(b.closest('tr').dataset.email, 'invite'); }); });
      document.querySelectorAll('.staff-remove').forEach(function(b){ b.addEventListener('click', function(){ staffRemove(b.closest('tr').dataset.email); }); });
    </script>
  </form>`;
}

export function renderSettingsPage(
  schedule: BusinessHoursSchedule,
  blocklist: string[],
  staffRoster: StaffPresenceRow[],
  staffAccess: { email: string; role: string; hasPassword: boolean }[],
  currentRole: "admin" | "staff"
): string {
  const dayRows = renderDayRows(schedule, "hours");

  const staffOptions = staffRoster
    .map((s) => `<option value="${escapeHtml(s.email)}">${escapeHtml(s.email)} (${escapeHtml(s.role)})</option>`)
    .join("");

  const staffForms = staffRoster
    .map((staffMember) => {
      const idPrefix = `staff-${domIdSafe(staffMember.email)}`;
      return `<div class="staff-form-wrap" data-staff="${escapeHtml(staffMember.email)}" style="display:none">
        <form class="staff-schedule-form" id="${idPrefix}-form" data-email="${escapeHtml(staffMember.email)}">
          <div class="staff-availability">
            <span class="staff-avail-label">Availability</span>
            <button type="button" class="staff-status-btn${staffMember.status === "available" ? " active" : ""}" data-status="available">Available</button>
            <button type="button" class="staff-status-btn${staffMember.status === "away" ? " active" : ""}" data-status="away">Away</button>
            <span class="staff-status-msg"></span>
          </div>
          <label class="staff-priority-label">Ring priority (lower rings first)
            <input type="number" class="staff-priority-input" value="${staffMember.ringPriority}" min="0" max="9999" step="1">
            <button type="button" class="staff-priority-save">Save priority</button>
            <span class="staff-priority-status"></span>
          </label>
          ${renderDayRows(staffMember.schedule, idPrefix)}
          <button type="submit">Save Schedule</button>
          <span class="staff-save-status"></span>
        </form>
      </div>`;
    })
    .join("");

  const body = `<h2>Settings</h2>
    <style>
      .settings-subnav { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
      .settings-subnav-card { flex: 1; min-width: 200px; display: block; text-decoration: none; background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 12px; padding: 0.9rem 1.1rem; color: var(--admin-text); transition: background 0.12s, border-color 0.12s; }
      .settings-subnav-card:hover { background: var(--admin-surface-hover); border-color: var(--admin-brand); }
      .settings-subnav-card strong { display: block; font-size: 0.98rem; }
      .settings-subnav-card span { color: var(--admin-dim); font-size: 0.82rem; }
      .staff-picker-label { display: block; margin-bottom: 1rem; font-weight: 600; }
      .staff-picker-label select { margin-left: 0.5rem; min-width: 260px; font-weight: 400; }
      .staff-form-wrap .staff-schedule-form { border: 1px solid var(--admin-border); border-radius: 10px; padding: 0.6rem 0.9rem 0.9rem; background: var(--admin-bg); }
      .staff-form-wrap .staff-schedule-form label { display: block; margin-bottom: 0.6rem; margin-top: 0.6rem; }
      .staff-form-wrap .staff-schedule-form input { margin-left: 0.4rem; }
      .staff-form-wrap .staff-schedule-form button[type=submit] { background: var(--admin-brand); border-color: var(--admin-brand); color: #fff; font-weight: 600; margin-top: 0.5rem; }
      .staff-availability { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
      .staff-avail-label { color: var(--admin-dim); font-size: 0.82rem; margin-right: 0.2rem; }
      .staff-status-btn { padding: 0.3rem 0.8rem; border-radius: 999px; font-size: 0.82rem; }
      .staff-status-btn.active[data-status=available] { background: rgba(52,199,89,0.18); border-color: #34c759; color: #5ad19a; }
      .staff-status-btn.active[data-status=away] { background: rgba(228,0,43,0.18); border-color: var(--admin-brand); color: #ff8ea0; }
      .staff-status-msg { color: var(--admin-dim); font-size: 0.8rem; }
      .num-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.6rem 0; border-bottom: 1px solid var(--admin-border); }
      .num-row .num-e164 { font-family: monospace; color: var(--admin-dim); min-width: 130px; }
      .num-row input[type=text] { min-width: 160px; }
      .num-row label { font-size: 0.82rem; color: var(--admin-dim); display: inline-flex; align-items: center; gap: 0.25rem; }
      .num-row button { padding: 0.3rem 0.7rem; font-size: 0.82rem; }
      .num-add-grid { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
      .num-add-grid label { font-size: 0.82rem; color: var(--admin-dim); display: inline-flex; align-items: center; gap: 0.25rem; }
      .num-add-grid button { background: var(--admin-brand); border-color: var(--admin-brand); color: #fff; font-weight: 600; }
    </style>
    <div class="settings-subnav">
      <a class="settings-subnav-card" href="/admin/analytics"><strong>Analytics</strong><span>Call volume, answer rates &amp; trends</span></a>
      <a class="settings-subnav-card" href="/admin/ivr/main"><strong>IVR Flow</strong><span>Edit the phone menu &amp; call routing</span></a>
    </div>
    <form class="settings-form" id="business-hours-form">
      <h3>Business Hours</h3>
      ${dayRows}
      <button type="submit">Save Business Hours</button>
      <span id="hours-save-status"></span>
    </form>
    <form class="settings-form" id="blocklist-form">
      <h3>Call Blocklist</h3>
      <textarea id="blocklist-numbers" rows="6" placeholder="+61400000000">${escapeHtml(blocklist.join("\n"))}</textarea>
      <button type="submit">Save Blocklist</button>
      <span id="blocklist-save-status"></span>
    </form>
    ${
      currentRole === "admin"
        ? `<section class="settings-form" id="numbers-section">
      <h3>Phone Numbers</h3>
      <p style="color:var(--admin-dim);font-size:0.85rem;margin-top:0">The <strong>label</strong> is the name staff see in the "Call from" / "From" pickers. Tick <em>Voice</em>/<em>SMS</em> for what a number can do, and mark the defaults. (A number must already be set up in Twilio to actually send/receive.)</p>
      <div id="numbers-list">Loading…</div>
      <div style="margin-top:1rem;border-top:1px solid var(--admin-border);padding-top:1rem">
        <h4 style="margin:0 0 0.6rem">Add a number</h4>
        <div class="num-add-grid">
          <input type="text" id="num-add-e164" placeholder="+61…">
          <input type="text" id="num-add-label" placeholder="Label staff see">
          <label><input type="checkbox" id="num-add-voice"> Voice</label>
          <label><input type="checkbox" id="num-add-sms"> SMS</label>
          <button type="button" id="num-add-btn">Add</button>
          <span id="num-add-status" style="font-size:0.8rem;color:var(--admin-dim)"></span>
        </div>
      </div>
    </section>`
        : ""
    }
    <section class="settings-form">
      <h3>Staff Working Hours</h3>
      ${
        staffRoster.length === 0
          ? "<p>No staff members found.</p>"
          : `<label class="staff-picker-label">Staff member
              <select id="staff-picker">
                <option value="">Select a staff member…</option>
                ${staffOptions}
              </select>
            </label>
            <div id="staff-forms">${staffForms}</div>`
      }
    </section>
    ${currentRole === "admin" ? renderStaffAccess(staffAccess) : ""}
    <script>
      function scheduleFromForm(form) {
        const days = ${JSON.stringify(DAYS)};
        const schedule = {};
        for (const day of days) {
          const checked = form.querySelector('[name="' + day + '-open"]').checked;
          if (!checked) { schedule[day] = null; continue; }
          const start = form.querySelector('[name="' + day + '-start"]').value;
          const end = form.querySelector('[name="' + day + '-end"]').value;
          schedule[day] = { open: start, close: end };
        }
        return schedule;
      }

      document.getElementById('business-hours-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        const status = document.getElementById('hours-save-status');
        const res = await fetch('/api/settings/business-hours', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scheduleFromForm(e.target)),
        });
        status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
      });

      document.getElementById('blocklist-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        const status = document.getElementById('blocklist-save-status');
        const numbers = document.getElementById('blocklist-numbers').value
          .split('\\n')
          .map(function (line) { return line.trim(); })
          .filter(function (line) { return line !== ''; });
        const res = await fetch('/api/settings/call-blocklist', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(numbers),
        });
        status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
      });

      document.querySelectorAll('.staff-schedule-form').forEach(function (form) {
        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          const status = form.querySelector('.staff-save-status');
          const email = form.dataset.email;
          const res = await fetch('/api/staff/' + encodeURIComponent(email) + '/schedule', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(scheduleFromForm(form)),
          });
          status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
        });

        async function saveField(btnSelector, statusSelector, inputSelector, path, payloadKey) {
          const btn = form.querySelector(btnSelector);
          if (!btn) return;
          btn.addEventListener('click', async function () {
            const status = form.querySelector(statusSelector);
            const email = form.dataset.email;
            const value = form.querySelector(inputSelector).value;
            const payload = {}; payload[payloadKey] = value;
            const res = await fetch('/api/staff/' + encodeURIComponent(email) + path, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (res.ok) {
              status.textContent = 'Saved.';
            } else {
              let msg = 'Failed to save.';
              try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
              status.textContent = msg;
            }
          });
        }
        saveField('.staff-priority-save', '.staff-priority-status', '.staff-priority-input', '/priority', 'priority');

        form.querySelectorAll('.staff-status-btn').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            const email = form.dataset.email;
            const status = btn.dataset.status;
            const msg = form.querySelector('.staff-status-msg');
            const res = await fetch('/api/staff/' + encodeURIComponent(email) + '/status', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: status }),
            });
            if (res.ok) {
              form.querySelectorAll('.staff-status-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
              msg.textContent = 'Saved.';
            } else {
              msg.textContent = 'Failed to save.';
            }
          });
        });
      });

      var staffPicker = document.getElementById('staff-picker');
      if (staffPicker) {
        staffPicker.addEventListener('change', function () {
          var wraps = document.querySelectorAll('.staff-form-wrap');
          for (var i = 0; i < wraps.length; i++) {
            wraps[i].style.display = wraps[i].getAttribute('data-staff') === this.value ? 'block' : 'none';
          }
        });
      }

      // ---- Phone numbers (admin): rename / toggle capabilities / set defaults / add / delete ----
      async function loadNumbers() {
        var list = document.getElementById('numbers-list');
        if (!list) return;
        try {
          var res = await fetch('/api/numbers');
          if (!res.ok) { list.textContent = 'Could not load numbers.'; return; }
          renderNumbers((await res.json()) || []);
        } catch (e) { list.textContent = 'Could not load numbers.'; }
      }
      function renderNumbers(nums) {
        var list = document.getElementById('numbers-list');
        list.innerHTML = '';
        if (!nums.length) { list.textContent = 'No numbers yet.'; return; }
        nums.forEach(function (n) {
          var row = document.createElement('div'); row.className = 'num-row';
          var e = document.createElement('span'); e.className = 'num-e164'; e.textContent = n.e164;
          var label = document.createElement('input'); label.type = 'text'; label.value = n.label;
          function chk(checked, text) { var l = document.createElement('label'); var i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!checked; l.appendChild(i); l.appendChild(document.createTextNode(' ' + text)); l._input = i; return l; }
          var voice = chk(n.voice_enabled, 'Voice');
          var sms = chk(n.sms_enabled, 'SMS');
          var dv = chk(n.is_default_voice, 'Default call');
          var ds = chk(n.is_default_sms, 'Default text');
          var save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
          var del = document.createElement('button'); del.type = 'button'; del.textContent = 'Delete';
          var st = document.createElement('span'); st.style.cssText = 'font-size:0.8rem;color:var(--admin-dim)';
          save.addEventListener('click', function () {
            st.textContent = 'Saving…';
            fetch('/api/numbers/' + n.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ e164: n.e164, label: label.value, voice_enabled: voice._input.checked, sms_enabled: sms._input.checked, is_default_voice: dv._input.checked, is_default_sms: ds._input.checked, region: n.region }) })
              .then(function (r) { st.textContent = r.ok ? 'Saved.' : 'Failed.'; if (r.ok) loadNumbers(); })
              .catch(function () { st.textContent = 'Failed.'; });
          });
          del.addEventListener('click', function () {
            if (!window.confirm('Delete ' + n.label + ' (' + n.e164 + ')?')) return;
            fetch('/api/numbers/' + n.id, { method: 'DELETE' }).then(function (r) { if (r.ok) loadNumbers(); });
          });
          [e, label, voice, sms, dv, ds, save, del, st].forEach(function (x) { row.appendChild(x); });
          list.appendChild(row);
        });
      }
      (function () {
        var btn = document.getElementById('num-add-btn');
        if (!btn) return;
        btn.addEventListener('click', function () {
          var status = document.getElementById('num-add-status');
          var e164 = document.getElementById('num-add-e164').value.trim();
          var label = document.getElementById('num-add-label').value.trim();
          if (!e164 || !label) { status.textContent = 'Enter a number and a label.'; return; }
          status.textContent = 'Adding…';
          fetch('/api/numbers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ e164: e164, label: label, voice_enabled: document.getElementById('num-add-voice').checked, sms_enabled: document.getElementById('num-add-sms').checked }) })
            .then(function (r) { if (r.ok) { status.textContent = 'Added.'; document.getElementById('num-add-e164').value = ''; document.getElementById('num-add-label').value = ''; loadNumbers(); } else { status.textContent = 'Could not add (already exists?).'; } })
            .catch(function () { status.textContent = 'Could not add.'; });
        });
      })();
      loadNumbers();
    </script>`;
  return renderLayout("Settings", "settings", body);
}

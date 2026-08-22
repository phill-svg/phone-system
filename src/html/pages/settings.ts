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
        if(r.ok){location.reload();}else{staffMsg(d.error||'Invite failed.');}
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

  const staffForms = staffRoster
    .map((staffMember) => {
      const idPrefix = `staff-${domIdSafe(staffMember.email)}`;
      return `<form class="settings-form staff-schedule-form" id="${idPrefix}-form" data-email="${escapeHtml(staffMember.email)}">
        <h4>${escapeHtml(staffMember.email)} <small>(${escapeHtml(staffMember.role)})</small></h4>
        <label class="staff-priority-label">Ring priority (lower rings first)
          <input type="number" class="staff-priority-input" value="${staffMember.ringPriority}" min="0" max="9999" step="1">
          <button type="button" class="staff-priority-save">Save priority</button>
          <span class="staff-priority-status"></span>
        </label>
        ${renderDayRows(staffMember.schedule, idPrefix)}
        <button type="submit">Save Schedule</button>
        <span class="staff-save-status"></span>
      </form>`;
    })
    .join("");

  const body = `<h2>Settings</h2>
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
    <section class="settings-form">
      <h3>Staff Working Hours</h3>
      ${staffForms || "<p>No staff members found.</p>"}
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
      });
    </script>`;
  return renderLayout("Settings", "settings", body);
}

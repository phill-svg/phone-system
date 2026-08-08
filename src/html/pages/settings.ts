import { escapeHtml, renderLayout } from "../layout";
import type { BusinessHoursSchedule } from "../../ivr/businessHours";
import type { StaffRingEntry } from "../../db/settings";

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

export function renderSettingsPage(schedule: BusinessHoursSchedule, ringList: StaffRingEntry[]): string {
  const dayRows = DAYS.map((day) => {
    const window = schedule[day];
    return `<label>
      <input type="checkbox" name="${day}-open" ${window ? "checked" : ""} onchange="document.getElementById('${day}-times').style.display = this.checked ? 'inline' : 'none'">
      ${DAY_LABELS[day]}
      <span id="${day}-times" style="display:${window ? "inline" : "none"}">
        <input type="time" name="${day}-start" value="${escapeHtml(window?.open ?? "07:00")}">
        to
        <input type="time" name="${day}-end" value="${escapeHtml(window?.close ?? "17:00")}">
      </span>
    </label>`;
  }).join("");

  const ringRows = ringList
    .map(
      (entry, i) => `<div class="ring-entry">
        <input type="text" name="ring-label-${i}" value="${escapeHtml(entry.label)}" placeholder="Label">
        <input type="text" name="ring-number-${i}" value="${escapeHtml(entry.number)}" placeholder="+61...">
      </div>`
    )
    .join("");

  const body = `<h2>Settings</h2>
    <form class="settings-form" id="business-hours-form">
      <h3>Business Hours</h3>
      ${dayRows}
      <button type="submit">Save Business Hours</button>
      <span id="hours-save-status"></span>
    </form>
    <form class="settings-form" id="ring-list-form">
      <h3>Staff Ring List <small>(used by staff call-routing — not active yet)</small></h3>
      <div id="ring-entries">${ringRows}</div>
      <button type="button" id="add-ring-entry">Add number</button>
      <button type="submit">Save Ring List</button>
      <span id="ring-save-status"></span>
    </form>
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

      document.getElementById('add-ring-entry').addEventListener('click', function () {
        const container = document.getElementById('ring-entries');
        const i = container.children.length;
        const div = document.createElement('div');
        div.className = 'ring-entry';
        div.innerHTML = '<input type="text" name="ring-label-' + i + '" placeholder="Label">' +
          '<input type="text" name="ring-number-' + i + '" placeholder="+61...">';
        container.appendChild(div);
      });

      document.getElementById('ring-list-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        const status = document.getElementById('ring-save-status');
        const entries = Array.from(document.querySelectorAll('.ring-entry')).map(function (div) {
          const label = div.querySelector('[name^="ring-label-"]').value;
          const number = div.querySelector('[name^="ring-number-"]').value;
          return { label: label, number: number };
        }).filter(function (entry) { return entry.number.trim() !== ''; });
        const res = await fetch('/api/settings/staff-ring-list', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entries),
        });
        status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
      });
    </script>`;
  return renderLayout("Settings", "settings", body);
}

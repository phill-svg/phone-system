import { escapeHtml, renderLayout } from "../layout";
import type { BusinessHoursSchedule } from "../../ivr/businessHours";

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

export function renderSettingsPage(schedule: BusinessHoursSchedule, blocklist: string[]): string {
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
    </script>`;
  return renderLayout("Settings", "settings", body);
}

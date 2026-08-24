import { renderLayout } from "../layout";
import type { CallStats } from "../../db/calls";

function fmtDuration(seconds: number): string {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function pct(part: number, whole: number): string {
  if (!whole) return "0%";
  return Math.round((part / whole) * 100) + "%";
}

export function renderAnalyticsPage(stats: CallStats, days: number): string {
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: "Total calls", value: String(stats.total), sub: `${stats.inbound} in · ${stats.outbound} out` },
    { label: "Answered", value: String(stats.answered), sub: pct(stats.answered, stats.inbound) + " of inbound" },
    { label: "Missed", value: String(stats.missed), sub: pct(stats.missed, stats.inbound) + " of inbound" },
    { label: "Voicemail", value: String(stats.voicemail) },
    { label: "Avg talk time", value: fmtDuration(stats.avgTalkSeconds) },
  ];

  const maxDay = stats.byDay.reduce((m, d) => Math.max(m, d.total), 0) || 1;
  const bars = stats.byDay
    .map((d) => {
      const h = Math.round((d.total / maxDay) * 100);
      const ansH = d.total ? Math.round((d.answered / d.total) * h) : 0;
      const label = d.day.slice(5); // MM-DD
      return `<div class="bar-col" title="${d.day}: ${d.total} calls, ${d.answered} answered">
        <div class="bar" style="height:${h}%"><div class="bar-answered" style="height:${ansH}%"></div></div>
        <div class="bar-total">${d.total}</div>
        <div class="bar-label">${label}</div>
      </div>`;
    })
    .join("");

  const extraHead = `<style>
    .kpi-row { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0; }
    .kpi { flex: 1; min-width: 150px; background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 12px; padding: 1.1rem 1.25rem; }
    .kpi-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--admin-mute); font-weight: 700; }
    .kpi-value { font-size: 2rem; font-weight: 700; margin-top: 0.35rem; font-variant-numeric: tabular-nums; }
    .kpi-sub { font-size: 0.78rem; color: var(--admin-dim); margin-top: 0.2rem; }
    .chart-card { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 12px; padding: 1.25rem 1.4rem 1rem; }
    .chart-title { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--admin-mute); margin: 0 0 1rem; }
    .chart { display: flex; align-items: flex-end; gap: 0.5rem; height: 200px; overflow-x: auto; }
    .bar-col { flex: 1; min-width: 26px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
    .bar { width: 60%; min-height: 2px; background: #33363f; border-radius: 4px 4px 0 0; display: flex; flex-direction: column; justify-content: flex-end; position: relative; }
    .bar-answered { width: 100%; background: var(--admin-brand); border-radius: 4px 4px 0 0; }
    .bar-total { font-size: 0.7rem; color: var(--admin-dim); margin-top: 0.3rem; font-variant-numeric: tabular-nums; }
    .bar-label { font-size: 0.62rem; color: var(--admin-mute); margin-top: 0.1rem; }
    .chart-legend { display: flex; gap: 1.2rem; margin-top: 0.9rem; font-size: 0.75rem; color: var(--admin-dim); }
    .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 0.35rem; vertical-align: middle; }
  </style>`;

  const body = `<h2>Analytics</h2>
    <p style="color:var(--admin-dim);font-size:0.85rem;margin-top:-0.4rem">Last ${days} days</p>
    <div class="kpi-row">
      ${tiles
        .map(
          (t) => `<div class="kpi"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div>${t.sub ? `<div class="kpi-sub">${t.sub}</div>` : ""}</div>`
        )
        .join("")}
    </div>
    <div class="chart-card">
      <p class="chart-title">Calls per day</p>
      <div class="chart">${bars || '<div style="color:var(--admin-mute)">No calls in this period.</div>'}</div>
      <div class="chart-legend">
        <span><span class="legend-dot" style="background:var(--admin-brand)"></span>Answered</span>
        <span><span class="legend-dot" style="background:#33363f"></span>Total</span>
      </div>
    </div>`;

  return renderLayout("Analytics", "settings", body, { extraHead });
}

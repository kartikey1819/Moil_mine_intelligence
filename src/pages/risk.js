/* Shortfall Risk & Alerts — portfolio risk matrix, weekly risk calendar, constraint decomposition, early warnings. */
import { api } from '../lib/api.js';
import { chart } from '../lib/charts.js';
import { card, kpi, loading, errorBox, badge, src, $, $$ } from '../lib/ui.js';
import { t, pct, esc, date, signedT } from '../lib/format.js';

const GROUP_COLORS = { Equipment: '#7a2f8b', Blasting: '#e0913a', Weather: '#2f7ed8', Dewatering: '#0ea5b7', Power: '#c4a000', Schedule: '#8a94a6' };
const ACTION_LABEL = { blast_reschedule: 'Re-schedule blasts', pump_boost: 'Add pump capacity', pm_blitz: 'PM blitz', critical_spares: 'Critical spares', hire: 'Hire / redeploy equipment', catchup_shift: 'Catch-up shift', plan: 'Open action plan' };

export async function mount(root, ctx) {
  root.innerHTML = `
    <div class="ph"><div><h2>Production shortfall risk</h2>
      <p>Probability that each mine falls more than 5% short of plan, how large the gap is likely to be, which constraint is causing it (TreeSHAP attribution: equipment downtime, weather, blasting delays, mine water, power, roster) and the early warnings behind it.</p></div>
      <div class="actions">${src('ml', 'Monte-Carlo × ML')} ${src('live', 'Live weather')}</div></div>
    <div class="grid g-6" id="rKpis">${Array(6).fill('<div class="card skeleton" style="height:112px"></div>').join('')}</div>
    <div class="grid g-2">
      ${card({ title: 'Risk matrix · next 4 weeks', sub: 'probability × expected shortfall · bubble = monthly plan', body: '<div id="rMatrix" class="chart lg"></div>' })}
      ${card({ title: 'Weekly risk calendar', sub: 'P(week below 90% of plan)', body: '<div id="rHeat" class="chart lg"></div>' })}
    </div>
    ${card({ title: 'What is driving the shortfall?', sub: 'tonnes lost vs a typical week, next 4 weeks, by constraint (TreeSHAP)', body: '<div id="rDrivers" class="chart" style="height:340px"></div>', foot: 'Negative = the constraint is expected to cost production relative to an average historical week at that mine. This is the analysis the problem statement asks for: equipment downtime, weather conditions and blasting delays, quantified per mine.' })}
    ${card({ title: 'Early-warning feed', sub: 'every alert carries its evidence, estimated impact and a linked corrective action', right: '<div class="row wrap" id="rFilters"></div>', body: `<div id="rAlerts">${loading('Evaluating alerts…')}</div>`, bodyCls: 'flush' })}`;

  try {
    const [risk, alerts] = await Promise.all([api('/risk'), api('/alerts')]);
    if (!ctx.isCurrent()) return;
    const P = risk.portfolio, mines = risk.mines;
    const highN = mines.filter((m) => m.next4.p_shortfall_5pct >= 0.7).length;
    $('#rKpis', root).innerHTML = [
      kpi({ label: 'Portfolio risk >5% · 4 wk', value: pct(P.next4.p_shortfall_5pct), tone: P.next4.p_shortfall_5pct >= 0.7 ? 'crit' : 'high', foot: `P(below plan) ${pct(P.next4.p_shortfall)}` }),
      kpi({ label: 'Expected shortfall · 4 wk', value: t(P.next4.expected_shortfall, { unit: false, d: 1 }), unit: P.next4.expected_shortfall >= 1e4 ? 'kt' : 't', foot: `of ${t(P.next4.plan)} plan · P90 case ${t(Math.max(0, P.next4.plan - P.next4.p10))}` }),
      kpi({ label: 'Expected shortfall · 13 wk', value: t(P.next13.expected_shortfall, { unit: false, d: 1 }), unit: 'kt', foot: `${pct(P.next13.expected_shortfall / P.next13.plan, 1)} of plan` }),
      kpi({ label: `${P.fy.label} gap (P50)`, value: t(Math.max(0, P.fy.plan - P.fy.p50), { unit: false, d: 1 }), unit: 'kt', tone: 'high', foot: `P(meet FY plan) ${pct(P.fy.p_meet)}` }),
      kpi({ label: 'Mines at high risk', value: `${highN}<small>/ ${mines.length}</small>`, tone: highN ? 'crit' : 'low', foot: mines.filter((m) => m.next4.p_shortfall_5pct >= 0.7).map((m) => esc(m.name.replace(' Mine', ''))).join(', ') || 'none' }),
      kpi({ label: 'Alerts', value: alerts.length, tone: alerts.some((a) => a.severity === 'Critical') ? 'crit' : '', foot: ['Critical', 'High', 'Medium'].map((s) => badge(s, `${alerts.filter((a) => a.severity === s).length} ${s.toLowerCase()}`)).join(' ') }),
    ].join('');

    // ---- risk matrix
    chart($('#rMatrix', root), (p) => ({
      legend: false,
      tooltip: { trigger: 'item', formatter: (d) => { const m = mines[d.dataIndex]; return `<b>${esc(m.name)}</b><br>P(&gt;5% shortfall) <b>${pct(m.next4.p_shortfall_5pct)}</b><br>Expected shortfall ${t(m.next4.expected_shortfall)}<br>P50 ${t(m.next4.p50)} vs plan ${t(m.next4.plan)}`; } },
      grid: { left: 14, right: 80, top: 24, bottom: 26, containLabel: true },
      xAxis: { type: 'value', min: 0, max: 1, name: 'probability of >5% shortfall', nameLocation: 'middle', nameGap: 28, axisLabel: { formatter: (v) => `${Math.round(v * 100)}%` } },
      yAxis: { type: 'value', name: 'expected shortfall (t)', nameLocation: 'middle', nameGap: 48 },
      series: [{
        type: 'scatter', data: mines.map((m) => [m.next4.p_shortfall_5pct, m.next4.expected_shortfall, m.next4.plan]),
        symbolSize: (v) => 12 + Math.sqrt(v[2]) / 7,
        itemStyle: { color: (d) => (d.value[0] >= 0.7 ? p.crit : d.value[0] >= 0.4 ? p.med : p.low), opacity: 0.85, borderColor: p.surface, borderWidth: 2 },
        label: { show: true, formatter: (d) => mines[d.dataIndex].name.replace(' Mine', ''), position: 'right', color: p.text2, fontSize: 11 },
        markArea: { silent: true, itemStyle: { color: 'rgba(217,45,32,0.06)' }, data: [[{ xAxis: 0.7 }, { xAxis: 1 }]] },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: p.faint, type: 'dashed' }, label: { color: p.muted, fontSize: 10 }, data: [{ xAxis: 0.4, label: { formatter: 'medium' } }, { xAxis: 0.7, label: { formatter: 'high' } }] },
      }],
    }));

    // ---- weekly heatmap
    const weeks = mines[0].weeks.slice(0, 13).map((w) => w.start);
    const heat = [];
    mines.forEach((m, i) => m.weeks.slice(0, 13).forEach((w, j) => heat.push([j, i, +w.p_below_90.toFixed(2)])));
    chart($('#rHeat', root), (p) => ({
      legend: false,
      tooltip: { trigger: 'item', formatter: (d) => { const m = mines[d.value[1]], w = m.weeks[d.value[0]]; return `<b>${esc(m.name)}</b> · week of ${date(w.start)}<br>P(&lt;90% of plan) <b>${pct(w.p_below_90)}</b><br>P50 ${t(w.p50)} / plan ${t(w.plan)}`; } },
      grid: { left: 8, right: 10, top: 10, bottom: 50, containLabel: true },
      xAxis: { type: 'category', data: weeks.map((d) => date(d)), splitArea: { show: false }, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'category', data: mines.map((m) => m.name.replace(' Mine', '')), axisLabel: { fontSize: 11 } },
      visualMap: { min: 0, max: 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 180, itemWidth: 10, text: ['100%', '0%'], textStyle: { color: p.muted, fontSize: 10 }, inRange: { color: ['#eefbf2', '#fde68a', '#f59e0b', '#dc2626', '#7f1d1d'] } },
      series: [{ type: 'heatmap', progressive: 0, data: heat, label: { show: true, fontSize: 9.5, formatter: (d) => (d.value[2] >= 0.1 ? Math.round(d.value[2] * 100) : ''), color: '#111' }, itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 } }],
    }));

    // ---- driver decomposition
    const groups = Object.keys(GROUP_COLORS);
    chart($('#rDrivers', root), (p) => ({
      legend: { data: groups },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => (v == null ? '—' : signedT(v)) },
      grid: { left: 8, right: 20, top: 34, bottom: 4, containLabel: true },
      xAxis: { type: 'value', axisLabel: { formatter: (v) => (Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v) } },
      yAxis: { type: 'category', data: mines.map((m) => m.name.replace(' Mine', '')), inverse: true },
      series: groups.map((g) => ({ name: g, type: 'bar', stack: 'x', barMaxWidth: 22, itemStyle: { color: GROUP_COLORS[g] }, emphasis: { focus: 'series' },
        data: mines.map((m) => m.attribution?.groups.find((x) => x.group === g)?.tonnes ?? 0) })),
    }));

    // ---- alerts feed
    const filt = { sev: 'all', cat: 'all', mine: 'all' };
    const cats = [...new Set(alerts.map((a) => a.category))];
    $('#rFilters', root).innerHTML = `
      <div class="seg" data-f="sev">${['all', 'Critical', 'High', 'Medium'].map((s) => `<button data-v="${s}" class="${s === 'all' ? 'on' : ''}">${s === 'all' ? 'All' : s}</button>`).join('')}</div>
      <select class="input" data-f="cat"><option value="all">All categories</option>${cats.map((c) => `<option>${c}</option>`).join('')}</select>
      <select class="input" data-f="mine"><option value="all">All mines</option>${mines.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>`;
    const draw = () => {
      const list = alerts.filter((a) => (filt.sev === 'all' || a.severity === filt.sev) && (filt.cat === 'all' || a.category === filt.cat) && (filt.mine === 'all' || a.mine_id === filt.mine));
      $('#rAlerts', root).innerHTML = list.length ? list.map((a) => `<div class="alert-item ${a.severity}"><div class="rail"></div>
        <div><h4>${esc(a.title)}</h4><p>${esc(a.detail)}</p>
          <div class="meta">${badge(a.severity)}<b>${esc(a.mine)}</b><span>${esc(a.category)}</span><span>⏱ ${esc(a.window)}</span><span class="src ${a.source.includes('Live') ? 'live' : a.source.includes('model') || a.source.includes('Monte') ? 'ml' : 'sim'}">${esc(a.source)}</span>
          ${a.action_hint ? `<a href="#/actions" data-mine="${a.mine_id}" class="btn sm act">→ ${esc(ACTION_LABEL[a.action_hint] || 'Action plan')}</a>` : ''}</div></div>
        <div class="impact">${a.impact_t ? t(a.impact_t) : '—'}<small>production at risk</small></div></div>`).join('') : '<div class="loading-block">No alerts match the filter.</div>';
      $$('#rAlerts .act', root).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); window.goMine(b.dataset.mine, 'actions'); }));
    };
    $$('#rFilters [data-f]', root).forEach((el) => {
      if (el.tagName === 'SELECT') el.addEventListener('change', () => { filt[el.dataset.f] = el.value; draw(); });
      else el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); filt.sev = b.dataset.v; draw(); }));
    });
    draw();
  } catch (e) {
    root.insertAdjacentHTML('beforeend', errorBox(e));
  }
}

/* Action Planner — optimised corrective actions (schedule, blasting, equipment redeployment, maintenance,
 * dewatering), each valued by the Monte-Carlo × ML forecast; live re-simulation and a what-if simulator. */
import { api, post } from '../lib/api.js';
import { chart } from '../lib/charts.js';
import { card, kpi, loading, errorBox, badge, src, $, $$, download, toast } from '../lib/ui.js';
import { t, pct, esc, date, inr, signedT, num, pp } from '../lib/format.js';
import { mineMeta } from '../lib/store.js';

const CAT_ICON = { 'Equipment redeployment': '⇄', 'Equipment hire': '＋', Maintenance: '🔧', 'Mine schedule': '◷', Blasting: '✸', Dewatering: '≋' };
const CAT_TONE = { 'Equipment redeployment': 'brand', 'Equipment hire': 'brand', Maintenance: 'info', 'Mine schedule': 'medium', Blasting: 'high', Dewatering: 'info' };

function compareChart(el, base, alt, altName = 'With plan') {
  const W = base.weeks;
  chart(el, (p) => ({
    legend: { data: ['Plan', 'Baseline P50', altName, 'Baseline P10–P90'] },
    tooltip: { trigger: 'axis', formatter: (it) => { const i = it[0].dataIndex; return `<b>Week of ${date(W[i].start)}</b><br>Plan ${t(W[i].plan)}<br>Baseline mean ${t(W[i].mean)}<br>${altName} mean <b>${t(alt.weeks[i].mean)}</b> (${signedT(alt.weeks[i].mean - W[i].mean)})`; } },
    xAxis: { type: 'category', data: W.map((w) => date(w.start)) },
    yAxis: { type: 'value', scale: true, axisLabel: { formatter: (v) => (v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v) } },
    series: [
      { name: 'Plan', type: 'line', step: 'middle', data: W.map((w) => w.plan), symbol: 'none', lineStyle: { color: p.plan, type: 'dashed' } },
      { name: 'lo', type: 'line', stack: 'b', data: W.map((w) => w.p10), symbol: 'none', lineStyle: { opacity: 0 }, silent: true },
      { name: 'Baseline P10–P90', type: 'line', stack: 'b', data: W.map((w) => w.p90 - w.p10), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(152,160,177,.18)' }, itemStyle: { color: 'rgba(152,160,177,.4)' }, silent: true },
      { name: 'Baseline P50', type: 'line', data: W.map((w) => w.mean), symbol: 'circle', symbolSize: 4, lineStyle: { color: p.actual, width: 2 }, itemStyle: { color: p.actual } },
      { name: altName, type: 'line', data: alt.weeks.map((w) => w.mean), symbol: 'circle', symbolSize: 5, lineStyle: { color: p.low, width: 3 }, itemStyle: { color: p.low }, areaStyle: { color: 'rgba(22,163,74,.08)' } },
    ],
  }));
}

export async function mount(root, ctx) {
  const m = mineMeta(ctx.mine);
  root.innerHTML = `
    <div class="ph"><div><h2>${esc(m.name)} · corrective action plan</h2>
      <p>Every candidate action — mine-schedule changes, blasting optimisation, equipment redeployment between MOIL mines, maintenance and dewatering — is tested against the same 150 simulated futures (common random numbers) with the production model, valued at ₹13,500/t net of cost, and combined greedily into a plan that is then re-simulated as a whole.</p></div>
      <div class="actions"><button class="btn" id="aExport"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/></svg>Export plan (CSV)</button>${src('ml', 'Optimiser')}</div></div>
    <div class="grid g-6" id="aKpis">${Array(6).fill('<div class="card skeleton" style="height:112px"></div>').join('')}</div>
    <div class="grid g-3-2">
      ${card({ title: 'Recommended actions', sub: 'ranked by net value · tick to build your own plan', right: '<button class="btn primary sm" id="aResim" disabled>Re-simulate selection</button>', body: `<div id="aList" class="stack">${loading('Optimising…', 'simulating every candidate action (≈10–30 s the first time)')}</div>` })}
      <div class="stack">
        ${card({ title: 'Forecast with the plan', sub: 'next 13 weeks · mean of simulated paths', body: '<div id="aCompare" class="chart"></div><div id="aCompareNote" class="small muted"></div>' })}
        ${card({ title: 'Implementation timeline', sub: 'lead time → effect window', body: '<div id="aGantt" class="chart sm"></div>' })}
      </div>
    </div>
    ${card({ title: 'What-if scenario simulator', sub: 'set the levers, simulate 150 futures', right: src('ml', 'Monte-Carlo × ML'), body: `
      <div class="grid g-3-2">
        <div class="grid g-2" id="simForm">
          <div class="field"><label>Weather scenario</label><select class="input" data-k="wx"><option value="forecast">Live forecast + climatology</option><option value="dry">Dry spell (−75% rain)</option><option value="wet">Severe monsoon (+70% rain)</option></select></div>
          <div class="field"><label>Scheduled hours / day <b id="lShift"></b></label><input type="range" data-k="shiftH" min="10" max="23" step="1"></div>
          <div class="field"><label>Fleet availability uplift <b id="lAvail">0%</b></label><input type="range" data-k="availUplift" min="0" max="0.15" step="0.01" value="0"></div>
          <div class="field"><label>Extra pumps (× ${m.method === 'OC' ? 'pit' : 'main'} pump) <b id="lPump">0</b></label><input type="range" data-k="pumpBoost" min="0" max="2" step="1" value="0"></div>
          <div class="field"><label>Rain-aware blast scheduling <b id="lBlast">0%</b></label><input type="range" data-k="blastMitigation" min="0" max="0.9" step="0.1" value="0"></div>
          <div class="field"><label>Extra ${m.method === 'OC' ? 'dumpers' : 'LHDs'} <b id="lUnits">0</b></label><input type="range" data-k="units" min="0" max="4" step="1" value="0"></div>
          <label class="check"><input type="checkbox" data-k="fragImprove"> <span><b>Blast-design optimisation</b><br><span class="small muted">electronic delays, tighter burden/spacing</span></span></label>
          <label class="check"><input type="checkbox" data-k="pmCompliance"> <span><b>Enforce PM compliance</b><br><span class="small muted">PM deferral 28% → 5%</span></span></label>
          <label class="check"><input type="checkbox" data-k="criticalSpares"> <span><b>Critical spares at site</b><br><span class="small muted">winder / crusher MTTR −45%</span></span></label>
          <label class="check"><input type="checkbox" data-k="supplyBuffer"> <span><b>Explosive buffer stock</b><br><span class="small muted">rides through supply disruptions</span></span></label>
          <div class="span-2 row"><button class="btn primary" id="simRun">Run simulation</button><button class="btn" id="simReset">Reset</button><span class="small muted" id="simStatus"></span></div>
        </div>
        <div><div id="simChart" class="chart"></div><div id="simOut" class="grid g-3" style="gap:10px;margin-top:8px"></div></div>
      </div>` })}`;

  let plan;
  const selected = new Set();
  try {
    plan = await api(`/mines/${m.id}/actions`, { ttl: 5 * 60e3 });
    if (!ctx.isCurrent()) return;
  } catch (e) { $('#aList', root).innerHTML = errorBox(e); return; }

  const B = plan.baseline, P = plan.plan;
  const renderKpis = (after, cost, benefit) => {
    $('#aKpis', root).innerHTML = [
      kpi({ label: 'Gap to plan · 13 wk', value: t(plan.gap_13w, { unit: false, d: plan.gap_13w >= 1e4 ? 1 : 0 }), unit: plan.gap_13w >= 1e4 ? 'kt' : 't', tone: 'high', foot: `baseline mean ${t(B.next13.mean)} vs plan ${t(B.next13.plan)}` }),
      kpi({ label: 'Plan recovers · 13 wk', value: signedT(after.next13.mean - B.next13.mean), tone: 'low', bar: plan.gap_13w ? (after.next13.mean - B.next13.mean) / plan.gap_13w : 1, foot: `${pct(plan.gap_13w ? (after.next13.mean - B.next13.mean) / plan.gap_13w : 1)} of the gap closed` }),
      kpi({ label: 'Risk >5% shortfall · 4 wk', value: `${pct(B.next4.p_shortfall_5pct)} → ${pct(after.next4.p_shortfall_5pct)}`, tone: after.next4.p_shortfall_5pct < B.next4.p_shortfall_5pct ? 'low' : '', foot: `<span class="delta ${after.next4.p_shortfall_5pct <= B.next4.p_shortfall_5pct ? 'up' : 'down'}">${pp(after.next4.p_shortfall_5pct - B.next4.p_shortfall_5pct)}</span> with the plan` }),
      kpi({ label: 'Plan cost', value: inr(cost), foot: `${selected.size} action(s)` }),
      kpi({ label: 'Value of recovered ore', value: inr(benefit), tone: 'low', foot: '@ ₹13,500 / t, net of donor-mine losses' }),
      kpi({ label: 'Return on plan', value: cost ? `${num(benefit / cost, 1)}×` : '—', tone: benefit > cost ? 'low' : 'high', foot: `net ${inr(benefit - cost)}` }),
    ].join('');
  };

  const actionById = Object.fromEntries(plan.actions.map((a) => [a.id, a]));
  plan.actions.filter((a) => a.selected).forEach((a) => selected.add(a.id));
  const drawList = () => {
    $('#aList', root).innerHTML = plan.actions.map((a, i) => `
      <div class="action-card ${selected.has(a.id) ? 'selected' : ''}" data-id="${a.id}">
        <input type="checkbox" class="pick" ${selected.has(a.id) ? 'checked' : ''} style="accent-color:var(--brand);width:17px;height:17px;margin-top:2px">
        <div><div class="row wrap" style="gap:6px;margin-bottom:5px"><span class="badge ${CAT_TONE[a.category] || 'neutral'}">${CAT_ICON[a.category] || ''} ${esc(a.category)}</span>${a.selected ? '<span class="badge low">★ in optimised plan</span>' : ''}<span class="small faint">#${i + 1}</span></div>
          <h4>${esc(a.title)}</h4><p>${esc(a.rationale)}</p>
          <div class="constraint"><b>Constraint:</b> ${esc(a.constraint)}${a.donor ? ` · <b>Donor impact:</b> −${t(a.donor.loss_t_13w)} at ${esc(a.donor.name)} (netted)` : ''}</div>
          <div class="foot"><span>Lead time <b>${a.lead_days} d</b></span><span>Cost <b>${inr(a.cost_lakh)}</b></span><span>4-wk effect <b>${signedT(a.delta_t_4w)}</b></span><span>Risk <b>${pp(a.delta_p_short_4w)}</b></span></div></div>
        <div class="metrics"><span class="small muted">net recovery · 13 wk</span><span class="big ${a.net_t_13w < 0 ? 'neg' : ''}">${signedT(a.net_t_13w)}</span>
          <span class="small">value <b>${inr(a.benefit_lakh)}</b></span><span class="small">ROI <b>${a.roi == null ? '—' : `${a.roi}×`}</b></span></div>
      </div>`).join('');
    $$('#aList .action-card', root).forEach((c) => c.querySelector('.pick').addEventListener('change', (e) => {
      e.target.checked ? selected.add(c.dataset.id) : selected.delete(c.dataset.id);
      c.classList.toggle('selected', e.target.checked);
      $('#aResim', root).disabled = false;
    }));
  };
  drawList();

  const drawGantt = () => {
    const acts = [...selected].map((id) => actionById[id]).filter(Boolean);
    const H = plan.horizon_weeks * 7;
    chart($('#aGantt', root), (p) => ({
      legend: false, grid: { left: 8, right: 16, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: 'item', formatter: (d) => `${esc(acts[d.dataIndex].title)}<br>lead ${acts[d.dataIndex].lead_days} d` },
      xAxis: { type: 'value', min: 0, max: H, axisLabel: { formatter: (v) => `D+${v}` } },
      yAxis: { type: 'category', data: acts.map((a) => a.title.length > 34 ? `${a.title.slice(0, 33)}…` : a.title), inverse: true, axisLabel: { fontSize: 10.5 } },
      series: [
        { type: 'bar', stack: 'g', data: acts.map((a) => a.lead_days), itemStyle: { color: p.surface3, borderRadius: 3 }, barMaxWidth: 16 },
        { type: 'bar', stack: 'g', data: acts.map((a) => (a.id === 'catchup_shift' ? 28 : H - a.lead_days)), itemStyle: { color: p.brand, borderRadius: 3 }, barMaxWidth: 16 },
      ],
    }));
  };

  const applyResult = (after, name = 'With plan') => {
    compareChart($('#aCompare', root), B, after, name);
    const acts = [...selected].map((id) => actionById[id]).filter(Boolean);
    const cost = acts.reduce((s, a) => s + a.cost_lakh, 0);
    const donorLoss = acts.reduce((s, a) => s + (a.donor?.loss_t_13w || 0), 0);
    const benefit = ((after.next13.mean - B.next13.mean) - donorLoss) * 0.135;
    renderKpis(after, cost, benefit);
    $('#aCompareNote', root).innerHTML = `Selected actions interact (they share bottlenecks), so the combined gain is re-simulated rather than summed: <b>${signedT(after.next13.mean - B.next13.mean)}</b> over 13 weeks vs ${signedT(acts.reduce((s, a) => s + a.delta_t_13w, 0))} if simply added.`;
    drawGantt();
  };
  applyResult(P.forecast);

  $('#aResim', root).addEventListener('click', async () => {
    const btn = $('#aResim', root);
    btn.disabled = true; btn.textContent = 'Simulating…';
    try {
      const r = await post(`/mines/${m.id}/simulate`, { actions: [...selected] });
      if (!ctx.isCurrent()) return;
      applyResult(r.scenario, 'With selection');
      toast(`Selection simulated: ${signedT(r.delta_t_13w)} over 13 weeks`);
    } catch (e) { toast(`Simulation failed: ${e.message}`); }
    btn.textContent = 'Re-simulate selection';
  });

  $('#aExport', root).addEventListener('click', () => {
    const rows = [['rank', 'selected', 'category', 'action', 'lead_days', 'cost_lakh', 'net_recovery_t_13w', 'delta_t_4w', 'delta_risk_pts_4w', 'value_lakh', 'roi', 'rationale', 'constraint']];
    plan.actions.forEach((a, i) => rows.push([i + 1, selected.has(a.id) ? 'yes' : 'no', a.category, a.title, a.lead_days, a.cost_lakh, a.net_t_13w, a.delta_t_4w, Math.round(a.delta_p_short_4w * 100), a.benefit_lakh, a.roi ?? '', a.rationale, a.constraint]));
    download(`${m.id}_action_plan_${plan.as_of}.csv`, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  });

  // ---- what-if simulator
  const std = m.shifts === 2 ? 14 : 21;
  const form = $('#simForm', root);
  const sh = form.querySelector('[data-k=shiftH]'); sh.value = std;
  const labels = () => {
    $('#lShift', root).textContent = `${sh.value} h${+sh.value === std ? ' (current)' : ''}`;
    $('#lAvail', root).textContent = `+${Math.round(form.querySelector('[data-k=availUplift]').value * 100)}%`;
    $('#lPump', root).textContent = form.querySelector('[data-k=pumpBoost]').value;
    $('#lBlast', root).textContent = `${Math.round(form.querySelector('[data-k=blastMitigation]').value * 100)}%`;
    $('#lUnits', root).textContent = form.querySelector('[data-k=units]').value;
  };
  form.addEventListener('input', labels); labels();
  $('#simReset', root).onclick = () => { form.querySelectorAll('input[type=range]').forEach((i) => { i.value = i.dataset.k === 'shiftH' ? std : 0; }); form.querySelectorAll('input[type=checkbox]').forEach((i) => { i.checked = false; }); form.querySelector('select').value = 'forecast'; labels(); };
  const runSim = async () => {
    const v = (k) => form.querySelector(`[data-k=${k}]`);
    const body = { wx: v('wx').value, availUplift: +v('availUplift').value, pumpBoost: +v('pumpBoost').value, blastMitigation: +v('blastMitigation').value,
      fragImprove: v('fragImprove').checked ? 0.6 : 0, pmCompliance: v('pmCompliance').checked, criticalSpares: v('criticalSpares').checked, supplyBuffer: v('supplyBuffer').checked };
    if (+sh.value !== std) body.shiftH = +sh.value;
    if (+v('units').value) body.extraUnits = [{ cls: m.method === 'OC' ? 'dumper' : 'lhd', count: +v('units').value, fromDay: 3 }];
    $('#simStatus', root).textContent = 'Simulating 150 futures…'; $('#simRun', root).disabled = true;
    try {
      const r = await post(`/mines/${m.id}/simulate`, body);
      if (!ctx.isCurrent()) return;
      compareChart($('#simChart', root), r.baseline, r.scenario, 'Scenario');
      const s = r.scenario, b = r.baseline;
      $('#simOut', root).innerHTML = [
        kpi({ label: 'Δ 4 weeks', value: signedT(r.delta_t_4w), tone: r.delta_t_4w >= 0 ? 'low' : 'crit', foot: `${t(s.next4.mean)} vs ${t(b.next4.mean)}` }),
        kpi({ label: 'Δ 13 weeks', value: signedT(r.delta_t_13w), tone: r.delta_t_13w >= 0 ? 'low' : 'crit', foot: `value ${inr(r.delta_t_13w * 0.135)}` }),
        kpi({ label: 'Risk >5% · 4 wk', value: `${pct(s.next4.p_shortfall_5pct)}`, foot: `baseline ${pct(b.next4.p_shortfall_5pct)}` }),
      ].join('');
      $('#simStatus', root).textContent = '';
    } catch (e) { $('#simStatus', root).textContent = `Failed: ${e.message}`; }
    $('#simRun', root).disabled = false;
  };
  $('#simRun', root).onclick = runSim;
  runSim();
}

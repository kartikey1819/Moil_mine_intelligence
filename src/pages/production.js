/* Production Forecast — history vs plan, probabilistic forecast, driver attribution (TreeSHAP),
 * live weather drivers, fleet health (reliability model), blasting and bottlenecks. */
import { api } from '../lib/api.js';
import { chart, fanChart, waterfall } from '../lib/charts.js';
import { card, kpi, loading, errorBox, badge, src, $ } from '../lib/ui.js';
import { t, pct, esc, date, weekday, signedT, num } from '../lib/format.js';
import { mineMeta } from '../lib/store.js';


export async function mount(root, ctx) {
  const m = mineMeta(ctx.mine);
  root.innerHTML = `
    <div class="ph"><div><h2>${esc(m.name)} · production forecast</h2>
      <p>${esc(m.method_label)} · plan ${t(m.annual_plan_t)} / yr · ${m.shifts}-shift roster. Weekly production is predicted by a gradient-boosted model from equipment, blasting, weather, mine-water, power and roster drivers; the drivers themselves are simulated forward 240 times from live weather and fitted reliability to give a probabilistic outlook.</p></div>
      <div class="actions">${src('live', 'Weather forecast')} ${src('real', 'ERA5 history')} ${src('sim', 'Ops history')} ${src('ml', 'GBM + TreeSHAP')}</div></div>
    <div class="grid g-6" id="pKpis">${Array(6).fill('<div class="card skeleton" style="height:112px"></div>').join('')}</div>
    <div class="grid g-3-2">
      ${card({ title: 'Weekly production vs plan', sub: 'last 12 months · forecast to financial-year end', right: '<div class="seg" id="pHorizon"><button data-h="13" class="on">13 wk</button><button data-h="27">FY end</button></div>', body: `<div id="pFan" class="chart lg">${loading('Simulating 240 futures…')}</div>` })}
      ${card({ title: 'Why the gap? · next 4 weeks', sub: 'TreeSHAP attribution of the ML forecast', body: '<div id="pWater" class="chart lg"></div>', foot: '<span id="pWaterNote"></span>' })}
    </div>
    <div class="grid g-2">
      ${card({ title: 'Weather drivers · live 16-day forecast', sub: 'rain, rain probability, max temperature', right: src('live', 'Open-Meteo'), body: '<div id="pWx" class="chart"></div>' })}
      ${card({ title: 'Simulated driver outlook', sub: 'weekly means across Monte-Carlo paths', body: '<div id="pDrv" class="chart"></div>' })}
    </div>
    ${card({ title: 'Fleet health · failure risk in the next 72 h', sub: 'Weibull reliability fitted per unit from the breakdown log (empirical-Bayes shrinkage to class)', right: src('sim', 'Maintenance log'), body: `<div class="tbl-wrap" id="pFleet" style="max-height:420px">${loading()}</div>`, bodyCls: 'flush' })}
    <div class="grid g-3-2">
      ${card({ title: 'Availability by function · 90 days', sub: '7-day rolling, target 85%', body: '<div id="pAvail" class="chart"></div>' })}
      ${card({ title: 'Where tonnes were lost · 12 months', sub: 'daily binding constraint', body: '<div id="pBott" class="chart"></div>' })}
    </div>
    <div class="grid g-2">
      ${card({ title: 'Blasting reliability vs rainfall', sub: 'cancellation rate from the blast log', body: '<div id="pBlast" class="chart sm"></div>' })}
      ${card({ title: 'Blast cancellations · 12 months', sub: 'by reason', body: '<div id="pReasons" class="chart sm"></div>' })}
    </div>
    ${card({ title: 'Last 14 days · shift report', sub: 'daily production and drivers', body: `<div class="tbl-wrap" id="pRecent">${loading()}</div>`, bodyCls: 'flush' })}`;

  try {
    const [fc, prod, eq, bl] = await Promise.all([api(`/mines/${m.id}/forecast`), api(`/mines/${m.id}/production?grain=week&days=364`), api(`/mines/${m.id}/equipment`), api(`/mines/${m.id}/blasting`)]);
    if (!ctx.isCurrent()) return;
    const hist = prod.series.slice(1, -1);
    const last30 = prod.recent;

    // ---- KPIs
    const n4 = fc.next4, n13 = fc.next13, fy = fc.fy;
    const avail = eq.trend.slice(-30).reduce((s, d) => s + ['avail_loading', 'avail_haulage', 'avail_hoisting'].filter((k) => d[k] != null).reduce((a, k, _, arr) => a + Math.min(1, d[k]) / arr.length, 0), 0) / Math.min(30, eq.trend.length);
    const today = last30[last30.length - 1];
    $('#pKpis', root).innerHTML = [
      kpi({ label: 'Next 4 weeks · P50', value: t(n4.p50, { unit: false, d: n4.p50 >= 1e4 ? 1 : 0 }), unit: n4.p50 >= 1e4 ? 'kt' : 't', tone: n4.p50 < n4.plan ? 'high' : 'low', foot: `<span class="delta ${n4.p50 < n4.plan ? 'down' : 'up'}">${signedT(n4.p50 - n4.plan)}</span> vs plan · P10–P90 ${t(n4.p10)}–${t(n4.p90)}` }),
      kpi({ label: 'Shortfall risk >5% · 4 wk', value: pct(n4.p_shortfall_5pct), tone: n4.p_shortfall_5pct >= 0.7 ? 'crit' : n4.p_shortfall_5pct >= 0.4 ? 'high' : 'low', foot: `${badge(n4.p_shortfall_5pct >= 0.7 ? 'High' : n4.p_shortfall_5pct >= 0.4 ? 'Medium' : 'Low')} P(below plan) ${pct(n4.p_shortfall)}` }),
      kpi({ label: 'Next 13 weeks · P50', value: t(n13.p50, { unit: false, d: 1 }), unit: 'kt', foot: `plan ${t(n13.plan)} · expected gap ${t(n13.expected_shortfall)}` }),
      kpi({ label: `${fy.label} outlook`, value: t(fy.p50, { unit: false, d: 1 }), unit: 'kt', bar: fy.p50 / fy.plan, foot: `plan ${t(fy.plan)} · P(meet) ${pct(fy.p_meet)}` }),
      kpi({ label: 'Fleet availability · 30 d', value: pct(avail, 1), tone: avail < 0.85 ? 'high' : 'low', foot: `target 85% · ${eq.units.filter((u) => u.status !== 'Operating').length} unit(s) down now` }),
      kpi({ label: 'Stock cover', value: `${num(today.rom_t / (today.plan * 0.93), 1)}`, unit: 'days', tone: today.rom_t / today.plan < 2 ? 'crit' : '', foot: `ROM ${t(today.rom_t)} · grade ${num(today.grade_mn, 1)}% Mn` }),
    ].join('');

    // ---- fan chart with horizon toggle
    const drawFan = (h) => fanChart($('#pFan', root), { hist, weeks: fc.weeks.slice(0, h) });
    drawFan(13);
    root.querySelectorAll('#pHorizon button').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('#pHorizon button').forEach((x) => x.classList.toggle('on', x === b)); drawFan(+b.dataset.h);
    }));

    // ---- waterfall (TreeSHAP)
    const A = fc.attribution;
    waterfall($('#pWater', root), { start: A.baseline, startLabel: 'Typical week ×4', items: A.groups.map((g) => ({ name: g.group, value: g.tonnes })), endLabel: 'Forecast', plan: A.plan });
    const worst = A.groups[0];
    $('#pWaterNote', root).innerHTML = `Largest drag: <b>${esc(worst.group)}</b> ${signedT(worst.tonnes)} — ${worst.features.filter((f) => f.tonnes < 0).slice(0, 2).map((f) => `${esc(f.label.toLowerCase())} (${signedT(f.tonnes)})`).join(', ') || 'n/a'}. Plan ${t(A.plan)} vs model expectation at mean conditions ${t(A.predicted_at_mean)}.`;

    // ---- live weather
    const wx = (fc.live_weather || []).filter((d) => d.date >= fc.start);
    if (wx.length) {
      chart($('#pWx', root), (p) => ({
        legend: { data: ['Rain (mm)', 'Rain probability', 'Max temp (°C)'] },
        xAxis: { type: 'category', data: wx.map((d) => `${weekday(d.date)} ${date(d.date)}`), axisLabel: { interval: 1, fontSize: 10 } },
        yAxis: [{ type: 'value', axisLabel: { formatter: '{value} mm' } }, { type: 'value', splitLine: { show: false }, min: 0, max: 100 }],
        series: [
          { name: 'Rain (mm)', type: 'bar', data: wx.map((d) => ({ value: d.rain_mm, itemStyle: { color: d.rain_mm >= (m.method === 'OC' ? 25 : 45) ? p.crit : '#3b82f6', borderRadius: [3, 3, 0, 0] } })), barMaxWidth: 16,
            markLine: { silent: true, symbol: 'none', data: [{ yAxis: m.method === 'OC' ? 25 : 45 }], lineStyle: { color: p.crit, type: 'dashed' }, label: { formatter: 'alert threshold', color: p.crit, fontSize: 10 } } },
          { name: 'Rain probability', type: 'line', yAxisIndex: 1, data: wx.map((d) => d.rain_prob), symbol: 'none', smooth: true, lineStyle: { color: '#93c5fd', width: 1.5 }, areaStyle: { color: 'rgba(147,197,253,.12)' } },
          { name: 'Max temp (°C)', type: 'line', yAxisIndex: 1, data: wx.map((d) => d.tmax_c), symbol: 'circle', symbolSize: 4, lineStyle: { color: p.high, width: 2 }, itemStyle: { color: p.high } },
        ],
      }));
    } else $('#pWx', root).innerHTML = '<div class="note">Live forecast unavailable — ERA5 climatology is used for every forecast day.</div>';

    // ---- driver outlook
    const W = fc.weeks.slice(0, 13);
    chart($('#pDrv', root), (p) => ({
      legend: { data: ['Fleet availability', 'Blasts executed', 'Flooding index', 'Rain (mm/wk)'] },
      tooltip: { valueFormatter: (v) => (v == null ? '—' : +v.toFixed(3)) },
      xAxis: { type: 'category', data: W.map((w) => date(w.start)) },
      yAxis: [{ type: 'value', min: 0, max: 1.1, axisLabel: { formatter: (v) => `${Math.round(v * 100)}%` } }, { type: 'value', splitLine: { show: false }, axisLabel: { formatter: '{value} mm' } }],
      series: [
        { name: 'Rain (mm/wk)', type: 'bar', yAxisIndex: 1, data: W.map((w) => w.drivers.rain_mm), itemStyle: { color: 'rgba(59,130,246,.35)', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
        { name: 'Fleet availability', type: 'line', data: W.map((w) => Math.min(1.1, w.drivers.fleet_avail)), symbol: 'none', lineStyle: { width: 2.5, color: p.brand } },
        { name: 'Blasts executed', type: 'line', data: W.map((w) => w.drivers.blast_exec), symbol: 'none', lineStyle: { width: 2, color: p.high } },
        { name: 'Flooding index', type: 'line', data: W.map((w) => w.drivers.flood_idx), symbol: 'none', lineStyle: { width: 2, color: '#0ea5e9', type: 'dashed' } },
      ],
    }));

    // ---- fleet table
    const riskOrder = { Down: 0, High: 1, Medium: 2, Low: 3 };
    const units = [...eq.units].sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || b.p_fail_72h - a.p_fail_72h);
    $('#pFleet', root).innerHTML = `<table class="tbl"><thead><tr><th>Unit</th><th>Function</th><th class="num">Avail. 12 m</th><th class="num">MTBF fit / nameplate</th><th>Hours since PM</th><th class="num">P(fail 72 h)</th><th>Status</th></tr></thead><tbody>
      ${units.map((u) => `<tr><td><b class="mono">${esc(u.id)}</b>${u.critical ? ' <span class="badge high" title="single point of failure">critical</span>' : ''}<div class="small muted">${esc(u.label)} · ${u.age_years} yr</div></td>
        <td>${esc(u.group_label)}</td><td class="num">${num(u.availability_12m, 1)}%</td>
        <td class="num">${num(u.mtbf_fit_h)} <span class="muted">/ ${num(u.mtbf_nameplate_h)} h</span></td>
        <td><div class="row"><div class="mini-bar" style="width:80px"><i style="width:${Math.min(100, (u.hours_since_pm / u.pm_interval_h) * 100)}%;background:${u.pm_overdue ? 'var(--crit)' : 'var(--brand)'}"></i></div><span class="mono small">${num(u.hours_since_pm)}/${u.pm_interval_h} h</span></div></td>
        <td class="num"><b style="color:${u.p_fail_72h >= 0.5 ? 'var(--crit)' : u.p_fail_72h >= 0.3 ? 'var(--high)' : 'inherit'}">${pct(u.p_fail_72h)}</b></td>
        <td>${u.status === 'Under repair' ? badge('Critical', `down · ${u.down_h_remaining} h`) : badge(u.risk === 'High' ? 'High' : u.risk === 'Medium' ? 'Medium' : 'Low', u.risk === 'Low' ? 'OK' : `${u.risk} risk`)}</td></tr>`).join('')}
      </tbody></table>`;

    // ---- availability trend
    const roll = (arr, k) => arr.map((_, i) => { const s = arr.slice(Math.max(0, i - 6), i + 1).filter((v) => v != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; });
    const groups = [['avail_loading', 'Loading'], ['avail_haulage', 'Haulage'], ['avail_hoisting', 'Hoisting'], ['avail_crushing', 'Crushing'], ['avail_drilling', 'Drilling'], ['avail_pumping', 'Dewatering']].filter(([k]) => eq.trend.some((d) => d[k] != null));
    chart($('#pAvail', root), (p) => ({
      legend: { data: groups.map((g) => g[1]), type: 'scroll' },
      tooltip: { valueFormatter: (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`) },
      xAxis: { type: 'category', data: eq.trend.map((d) => date(d.date)) },
      yAxis: { type: 'value', min: 0.5, max: 1.05, axisLabel: { formatter: (v) => `${Math.round(v * 100)}%` } },
      series: groups.map(([k, name]) => ({ name, type: 'line', smooth: true, symbol: 'none', data: roll(eq.trend.map((d) => (d[k] == null ? null : Math.min(1.05, d[k]))), 7), lineStyle: { width: 2 } }))
        .concat([{ name: 'target', type: 'line', data: eq.trend.map(() => 0.85), symbol: 'none', lineStyle: { color: p.plan, type: 'dashed', width: 1 }, tooltip: { show: false } }]),
    }));

    // ---- bottlenecks
    const B = prod.bottlenecks.filter((b) => b.lost > 0);
    const BL = { 'blasted-ore': 'Blasted ore (blasting)', 'mine-water': 'Mine water / flooding', plan: 'Plan-limited (other losses)', loading: 'Loading fleet', haulage: 'Haulage fleet', hoisting: 'Hoisting (winder)', crushing: 'Crushing plant' };
    chart($('#pBott', root), (p) => ({
      legend: { orient: 'vertical', right: 0, top: 'middle', icon: 'circle', textStyle: { color: p.text2, fontSize: 11 } }, tooltip: { trigger: 'item', formatter: (d) => `${d.name}<br><b>${t(d.value)}</b> lost · ${d.percent}%` },
      series: [{ type: 'pie', radius: ['45%', '72%'], center: ['28%', '52%'], itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 4 }, label: { position: 'inside', color: '#fff', fontSize: 10, fontWeight: 600, formatter: (d) => (d.percent >= 6 ? `${Math.round(d.percent)}%` : '') },
        data: B.map((b) => ({ name: BL[b.bottleneck] || b.bottleneck, value: Math.round(b.lost) })) }],
    }));

    // ---- blasting vs rain
    chart($('#pBlast', root), (p) => ({
      legend: false, tooltip: { formatter: (it) => `${it[0].name} mm/day<br>cancelled <b>${(it[0].value * 100).toFixed(0)}%</b> of ${bl.by_rain[it[0].dataIndex].n} blasts` },
      xAxis: { type: 'category', data: bl.by_rain.map((r) => r.bucket), name: 'rain mm/day', nameLocation: 'middle', nameGap: 26 },
      yAxis: { type: 'value', max: 1, axisLabel: { formatter: (v) => `${Math.round(v * 100)}%` } },
      series: [{ type: 'bar', data: bl.by_rain.map((r) => ({ value: r.cancel_rate, itemStyle: { color: r.cancel_rate > 0.4 ? p.crit : r.cancel_rate > 0.15 ? p.high : p.brand, borderRadius: [4, 4, 0, 0] } })), barMaxWidth: 40,
        label: { show: true, position: 'top', formatter: (d) => `${Math.round(d.value * 100)}%`, color: p.muted, fontSize: 10 } }],
    }));
    chart($('#pReasons', root), (p) => ({
      legend: false, grid: { left: 8, right: 30, top: 10, bottom: 4, containLabel: true },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: bl.reasons.map((r) => r.reason).reverse(), axisLabel: { width: 170, overflow: 'truncate', fontSize: 10.5 } },
      series: [{ type: 'bar', data: bl.reasons.map((r) => r.n).reverse(), itemStyle: { color: p.rose, borderRadius: [0, 4, 4, 0] }, barMaxWidth: 16, label: { show: true, position: 'right', color: p.muted, fontSize: 10 } }],
    }));

    // ---- recent days
    $('#pRecent', root).innerHTML = `<table class="tbl"><thead><tr><th>Date</th><th class="num">Plan</th><th class="num">Actual</th><th>Attainment</th><th class="num">Fleet avail.</th><th class="num">Downtime</th><th class="c">Blasts</th><th class="num">Rain</th><th class="num">Soil moist.</th><th class="num">Flooding</th><th class="num">Shift h</th><th>Binding constraint</th><th class="num">Grade</th><th class="num">Dispatch</th></tr></thead><tbody>
      ${[...last30].reverse().map((d) => `<tr><td class="nowrap">${weekday(d.date)} ${date(d.date)}</td><td class="num">${num(d.plan)}</td><td class="num"><b>${num(d.actual)}</b></td>
        <td><div class="row"><div class="mini-bar" style="width:70px"><i style="width:${Math.min(100, d.attainment * 100)}%;background:${d.attainment < 0.8 ? 'var(--crit)' : d.attainment < 0.95 ? 'var(--med)' : 'var(--low)'}"></i></div><span class="mono small">${pct(d.attainment)}</span></div></td>
        <td class="num">${pct(Math.min(1, d.fleet_avail))}</td><td class="num">${num(d.downtime_h)} h</td><td class="c mono">${d.blasts}</td><td class="num">${num(d.rain_mm, 1)}</td><td class="num">${num(d.soil_moisture, 2)}</td>
        <td class="num" style="color:${d.flood > 0.1 ? 'var(--crit)' : 'inherit'}">${pct(d.flood)}</td><td class="num">${num(d.shift_hours, 1)}</td><td>${esc(BL[d.bottleneck] || d.bottleneck)}</td><td class="num">${num(d.grade_mn, 1)}%</td><td class="num">${num(d.dispatch)}</td></tr>`).join('')}
      </tbody></table>`;
  } catch (e) {
    root.insertAdjacentHTML('beforeend', errorBox(e));
  }
}

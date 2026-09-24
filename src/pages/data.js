/* Data & Models — architecture, data lineage & live source health, model cards, validation, MOIL data import + retrain. */
import { api, clearApiCache } from '../lib/api.js';
import { chart } from '../lib/charts.js';
import { card, loading, errorBox, badge, src, $, download, toast } from '../lib/ui.js';
import { t, esc, num, date, ago, dateLong } from '../lib/format.js';
import { state } from '../lib/store.js';

export async function mount(root, ctx) {
  root.innerHTML = `
    <div class="ph"><div><h2>Data, models &amp; lineage</h2>
      <p>What the platform runs on: which inputs are real and live, which are prototype stand-ins for MOIL's own systems, how every model was validated — and how MOIL data replaces the simulated layers without touching the dashboard.</p></div>
      <div class="actions"><a class="btn" href="model-lab.html" target="_blank">Prospectivity Model Lab ↗</a></div></div>
    ${card({ title: 'Solution architecture', sub: 'space technology + operations data → ML → decisions', body: `
      <div class="arch">
        <div class="arch-col"><h5>1 · Data sources</h5>
          <div class="arch-box space"><b>Sentinel-2 L2A · Landsat 8/9 TIRS</b><span>spectral ratios, NDVI, land-surface temperature — live via Planetary Computer</span></div>
          <div class="arch-box space"><b>ERA5-Land · 16-day NWP forecast</b><span>rainfall, soil moisture, temperature — live via Open-Meteo</span></div>
          <div class="arch-box space"><b>Copernicus DEM · NASA GIBS (IMERG, SMAP, MODIS)</b><span>terrain, regional rain / soil-moisture / LST / NDVI maps</span></div>
          <div class="arch-box ops"><b>Operations (ERP / SCADA / shift reports)</b><span>production, dispatch, fleet, breakdowns, blasts — simulated stand-in, CSV import ready</span></div>
          <div class="arch-box ops"><b>Geology (drilling DB, geological map)</b><span>collars, surveys, assays; Macrostrat lithology; OSM workings</span></div></div>
        <div class="arch-col"><h5>2 · Data layer</h5>
          <div class="arch-box"><b>SQLite operational store</b><span>daily_ops, equipment, equipment_events, blast_log, weather_daily, boreholes, borehole_intervals, dem_grid, model_registry</span></div>
          <div class="arch-box"><b>Live ingest (every 3 h)</b><span>pulls newest reanalysis + forecast-model analysis, appends missing operating days, refreshes caches</span></div>
          <div class="arch-box"><b>REST API · Node / Express</b><span>/overview /forecast /risk /actions /reserves /sources /models /import</span></div>
          <div class="arch-box"><b>Worker pool</b><span>Monte-Carlo, kriging & optimisation run on all CPU cores</span></div></div>
        <div class="arch-col"><h5>3 · Models</h5>
          <div class="arch-box ml"><b>Prospectivity · XGBoost + TreeSHAP</b><span>surface indicators → P(Mn ground); leave-one-mine-out validated; runs in the browser</span></div>
          <div class="arch-box ml"><b>Resource estimation · ordinary kriging</b><span>variography, UNFC 111–333 classification, depletion, infill targeting</span></div>
          <div class="arch-box ml"><b>Production attainment · monotone GBM</b><span>equipment · blasting · weather · water · power · roster → weekly output; exact TreeSHAP</span></div>
          <div class="arch-box ml"><b>Reliability · Weibull (empirical Bayes)</b><span>per-unit MTBF / MTTR fitted from the breakdown log</span></div>
          <div class="arch-box ml"><b>Monte-Carlo forecaster + optimiser</b><span>240 futures per mine, common random numbers, greedy plan with donor-mine netting</span></div></div>
        <div class="arch-col"><h5>4 · Decisions</h5>
          <div class="arch-box ui"><b>Satellite prospecting</b><span>ranked targets, new G4 targets vs known lodes</span></div>
          <div class="arch-box ui"><b>Subsurface &amp; reserves</b><span>3D model, UNFC statement, mine life, infill drilling</span></div>
          <div class="arch-box ui"><b>Production forecast · risk &amp; alerts</b><span>P10–P90 outlook, shortfall probability, drivers, early warnings</span></div>
          <div class="arch-box ui"><b>Action planner</b><span>schedule / blasting / equipment redeployment plan, what-if simulator</span></div>
          <div class="arch-box ui"><b>Layer-2 contract · CSV / GeoJSON</b><span>hand-off to mine planning &amp; GIS</span></div></div>
      </div>` })}
    <div class="grid g-2">
      ${card({ title: 'External data sources · live health', sub: 'probed now', right: '<button class="btn sm" id="dProbe">Re-check</button>', body: `<div class="tbl-wrap" id="dExt">${loading('Probing endpoints…')}</div>`, bodyCls: 'flush' })}
      ${card({ title: 'Operational store', sub: 'SQLite tables & provenance', body: `<div class="tbl-wrap" id="dInt">${loading()}</div>`, bodyCls: 'flush' })}
    </div>
    <div class="grid g-3-2">
      ${card({ title: 'Production-attainment model', sub: 'time-based hold-out (last 26 weeks, all mines)', right: '<button class="btn primary sm" id="dRetrain">Retrain now</button>', body: '<div id="dProdCard"></div>' })}
      ${card({ title: 'Driver importance', sub: 'mean |SHAP| on the hold-out', body: '<div id="dImp" class="chart lg"></div>' })}
    </div>
    <div class="grid g-2">
      ${card({ title: 'Back-test · forecast vs actual', sub: 'hold-out weeks the model never saw', right: '<select class="input" id="dBtMine"></select>', body: '<div id="dBt" class="chart"></div>' })}
      ${card({ title: 'Prospectivity model validation', sub: 'leave-one-mine-out (spatial hold-out)', body: '<div id="dProsp"></div>' })}
    </div>
    ${card({ title: 'Bring MOIL data', sub: 'replace simulated production with actuals, then retrain', body: `
      <div class="grid g-2">
        <div class="stack"><p class="small" style="margin:0">Upload a CSV of daily production (<span class="mono">mine_id, date, actual_t</span> + optional <span class="mono">plan_t, dispatch_t, grade_mn</span>). Matching operating days are overwritten and tagged <i>MOIL upload</i>; forecasts refresh immediately and the model can be retrained on the new record.</p>
          <div class="row wrap"><input type="file" id="dFile" accept=".csv,text/csv" class="input"><button class="btn primary" id="dUpload">Upload &amp; import</button><button class="btn" id="dTemplate">Download template</button></div>
          <div id="dImportOut" class="small"></div></div>
        <div class="note"><b>Production path.</b> The same interfaces accept MOIL's systems: <b>SAP PM</b> work orders → <span class="mono">equipment_events</span>; <b>shift reports / weighbridge</b> → <span class="mono">daily_ops</span>; <b>blasting register</b> → <span class="mono">blast_log</span>; <b>drilling DB</b> (collar / survey / assay) → <span class="mono">boreholes</span>; approved <b>mine plan</b> → plan tonnages and mining depths. Satellite and weather layers are already live. The prospectivity model retrains on borehole outcomes with <span class="mono">python ml/train.py</span>.</div>
      </div>` })}`;

  const loadSources = async (fresh) => {
    try {
      const s = await api('/sources', { ttl: fresh ? 0 : 60e3 });
      if (!ctx.isCurrent()) return;
      $('#dExt', root).innerHTML = `<table class="tbl"><thead><tr><th>Source</th><th>Feeds</th><th>Used by</th><th class="c">Status</th><th class="num">Latency</th></tr></thead><tbody>
        ${s.external.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="small muted">${esc(x.provider)}</div></td><td class="small">${esc(x.feeds)}</td><td class="small">${esc(x.layer)}</td>
          <td class="c">${x.ok ? badge('low', 'LIVE') : badge('high', x.status ? `HTTP ${x.status}` : 'unreachable')}</td><td class="num">${x.ms} ms</td></tr>`).join('')}</tbody></table>
        <div class="card-f">Checked ${ago(s.checked_at)} · last ingest ${ago(s.last_ingest_at)} · database seeded ${dateLong(s.seeded_at?.slice(0, 10))}</div>`;
      $('#dInt', root).innerHTML = `<table class="tbl"><thead><tr><th>Dataset</th><th class="num">Rows</th><th>Range</th><th>Provenance</th></tr></thead><tbody>
        ${s.internal.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="small muted mono">${x.table}</div></td><td class="num">${num(x.rows)}</td><td class="small nowrap">${x.range ? `${date(x.range.a)} → ${date(x.range.b)}` : '—'}</td>
          <td>${x.provenance.startsWith('REAL') ? src('real', 'real') : src('sim', 'simulated')} <span class="small muted">${esc(x.provenance.replace(/^(REAL|SIMULATED)\s*[—-]?\s*/, ''))}</span></td></tr>`).join('')}</tbody></table>
        ${s.imports.length ? `<div class="card-f">Recent imports: ${s.imports.map((i) => `${esc(i.filename)} (${i.rows} rows, ${ago(i.at)})`).join(' · ')}</div>` : ''}`;
    } catch (e) { $('#dExt', root).innerHTML = errorBox(e); }
  };
  $('#dProbe', root).addEventListener('click', () => loadSources(true));
  loadSources(false);

  const loadModels = async () => {
    const md = await api('/models', { ttl: 0 });
    if (!ctx.isCurrent()) return;
    const pm = md.production, M = pm.metrics;
    const imp = (b, a) => Math.round((1 - a / b) * 100);
    $('#dProdCard', root).innerHTML = `
      <div class="row wrap" style="gap:8px;margin-bottom:10px">${badge('brand', `version ${pm.version}`)}${badge('neutral', `trained ${ago(pm.trained_at)}`)}${badge('neutral', `${pm.training.rows} mine-weeks · ${pm.training.mines} mines`)}${badge('neutral', `${pm.training.params.nTrees} trees · depth ${pm.training.params.maxDepth} · monotone constraints`)}</div>
      <div class="grid g-2"><div id="dMetrics" class="chart sm"></div>
      <div><table class="tbl"><thead><tr><th>Method</th><th class="num">MAE t/wk</th><th class="num">MAPE</th><th class="num">R²</th></tr></thead><tbody>
        <tr><td><b>ML model (this platform)</b></td><td class="num"><b>${M.model.mae_t}</b></td><td class="num">${M.model.mape_pct}%</td><td class="num">${M.model.r2}</td></tr>
        <tr><td>"Plan will be met" (status quo)</td><td class="num">${M.baseline_plan.mae_t}</td><td class="num">${M.baseline_plan.mape_pct}%</td><td class="num">${M.baseline_plan.r2}</td></tr>
        <tr><td>Last-4-weeks persistence</td><td class="num">${M.baseline_persistence.mae_t}</td><td class="num">${M.baseline_persistence.mape_pct}%</td><td class="num">${M.baseline_persistence.r2}</td></tr></tbody></table>
        <div class="note brand" style="margin-top:10px">Forecast error cut by <b>${imp(M.baseline_plan.mae_t, M.model.mae_t)}%</b> vs planning-as-usual and <b>${imp(M.baseline_persistence.mae_t, M.model.mae_t)}%</b> vs persistence, on weeks after ${date(pm.training.holdout_from)} that were never used for training.</div></div></div>
      <div class="small muted" style="margin-top:8px">Target: ${esc(pm.target)}. Monotone constraints encode engineering causality (more availability / blasts / shift hours can only help; more rain, flooding, downtime, outages can only hurt), so what-if answers stay physically consistent. Registry: ${md.registry.map((r) => `${r.version}${r.active ? ' (active)' : ''}`).join(', ')}.</div>`;
    chart($('#dMetrics', root), (p) => ({ legend: false, grid: { left: 6, right: 30, top: 8, bottom: 4, containLabel: true },
      xAxis: { type: 'value', name: 'MAE t/week' }, yAxis: { type: 'category', data: ['Plan (status quo)', 'Persistence', 'ML model'] },
      series: [{ type: 'bar', data: [M.baseline_plan.mae_t, M.baseline_persistence.mae_t, M.model.mae_t].map((v, i) => ({ value: v, itemStyle: { color: i === 2 ? p.brand : p.plan, borderRadius: [0, 4, 4, 0] } })), barMaxWidth: 22, label: { show: true, position: 'right', color: p.muted, fontSize: 10 } }] }));
    const I = pm.importance.slice(0, 12);
    const GC = { Equipment: '#7a2f8b', Blasting: '#e0913a', Weather: '#2f7ed8', Dewatering: '#0ea5b7', Power: '#c4a000', Schedule: '#8a94a6', Mine: '#999' };
    chart($('#dImp', root), () => ({ legend: false, grid: { left: 6, right: 40, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (it) => `${esc(I[it[0].dataIndex].label)}<br>${I[it[0].dataIndex].group} · mean |SHAP| ${it[0].value}` },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: I.map((i) => i.label), inverse: true, axisLabel: { fontSize: 10.5, width: 210, overflow: 'truncate' } },
      series: [{ type: 'bar', data: I.map((i) => ({ value: +i.mean_abs_shap.toFixed(4), itemStyle: { color: GC[i.group], borderRadius: [0, 4, 4, 0] } })), barMaxWidth: 16 }] }));
    const mines = [...new Set(pm.backtest.map((b) => b.mine_id))];
    $('#dBtMine', root).innerHTML = mines.map((id) => `<option value="${id}" ${id === state.mine ? 'selected' : ''}>${esc(state.meta.mines.find((m) => m.id === id)?.name || id)}</option>`).join('');
    const drawBt = (id) => {
      const B = pm.backtest.filter((b) => b.mine_id === id);
      chart($('#dBt', root), (p) => ({ legend: { data: ['Actual', 'ML model', 'Persistence', 'Plan'] }, tooltip: { valueFormatter: (v) => t(v) },
        xAxis: { type: 'category', data: B.map((b) => date(b.start)) }, yAxis: { type: 'value', scale: true },
        series: [
          { name: 'Actual', type: 'bar', data: B.map((b) => b.actual), itemStyle: { color: p.actual, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 12 },
          { name: 'ML model', type: 'line', data: B.map((b) => b.predicted), symbol: 'circle', symbolSize: 5, lineStyle: { color: p.brand, width: 2.5 }, itemStyle: { color: p.brand } },
          { name: 'Persistence', type: 'line', data: B.map((b) => b.persistence), symbol: 'none', lineStyle: { color: p.high, type: 'dotted', width: 1.5 } },
          { name: 'Plan', type: 'line', step: 'middle', data: B.map((b) => b.plan), symbol: 'none', lineStyle: { color: p.plan, type: 'dashed' } },
        ] }));
    };
    drawBt(mines.includes(state.mine) ? state.mine : mines[0]);
    $('#dBtMine', root).onchange = (e) => drawBt(e.target.value);

    const pr = md.prospectivity;
    if (pr?.validation) {
      const V = pr.validation.models;
      $('#dProsp', root).innerHTML = `<table class="tbl"><thead><tr><th>Model</th><th class="num">ROC-AUC</th><th class="num">PR-AUC</th><th class="num">Known Mn zones in top 5%</th></tr></thead><tbody>
        ${Object.entries(V).map(([k, v]) => `<tr ${k === 'xgboost' ? 'style="font-weight:700"' : ''}><td>${esc(k.replace(/_/g, ' '))}${k === 'xgboost' ? ' ' + badge('brand', 'deployed') : ''}</td><td class="num">${num(v.roc_auc, 3)}</td><td class="num">${num(v.pr_auc, 3)}</td><td class="num">${Math.round(v.top5pct_capture * 100)}%</td></tr>`).join('')}</tbody></table>
        <div class="small muted" style="padding:10px 0 0">Scheme: ${esc(pr.validation.scheme)}. Random ranking would give PR-AUC ≈ 0.02. ${esc((pr.limitations || [])[0] || '')}</div>`;
    } else $('#dProsp', root).innerHTML = '<div class="note">ml/metrics.json not found.</div>';
  };
  loadModels().catch((e) => { $('#dProdCard', root).innerHTML = errorBox(e); });

  $('#dRetrain', root).addEventListener('click', async () => {
    const b = $('#dRetrain', root); b.disabled = true; b.textContent = 'Training…';
    try {
      const r = await api('/models/production/retrain', { method: 'POST', body: '{}' });
      clearApiCache();
      toast(`Model ${r.version} trained · hold-out MAE ${r.metrics.model.mae_t} t/wk`);
      await loadModels();
    } catch (e) { toast(`Retrain failed: ${e.message}`); }
    b.disabled = false; b.textContent = 'Retrain now';
  });
  $('#dTemplate', root).addEventListener('click', () => download('moil_production_template.csv', `mine_id,date,actual_t,plan_t,dispatch_t,grade_mn\n${state.meta.mines.map((m) => `${m.id},${state.meta.as_of},,,,`).join('\n')}\n`, 'text/csv'));
  $('#dUpload', root).addEventListener('click', async () => {
    const f = $('#dFile', root).files[0];
    if (!f) { toast('Choose a CSV file first'); return; }
    try {
      const r = await api('/import/production', { method: 'POST', body: await f.text(), headers: { 'Content-Type': 'text/csv', 'X-Filename': f.name } });
      clearApiCache();
      $('#dImportOut', root).innerHTML = `<div class="note">Imported <b>${r.updated}</b> day(s), skipped ${r.skipped}. ${r.errors.map(esc).join(' · ')}<br>Next: press <b>Retrain now</b> to learn from the imported record.</div>`;
    } catch (e) { $('#dImportOut', root).innerHTML = errorBox(e); }
  });
}

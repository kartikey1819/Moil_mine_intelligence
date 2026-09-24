/* REST API — every screen of the dashboard is served from here. */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, getMeta, insertMany, ROOT } from './lib/db.mjs';
import { addDays, fiscalYear, weekStart } from './lib/dates.mjs';
import { MINES, MINE_BY_ID, ECONOMICS, EQUIPMENT_CLASSES, GROUP_LABEL } from './config/mines.mjs';
import { FEATURES } from './sim/mine-sim.mjs';
import { forecast, portfolioForecast, clearForecastCache } from './services/forecast.mjs';
import { actionPlan, simulateScenario } from './services/optimizer.mjs';
import { fleetHealth } from './services/equipment.mjs';
import { mineAlerts } from './services/alerts.mjs';
import { resources, reserveScene, boreholeLog } from './services/reserves.mjs';
import { liveForecast } from './services/weather.mjs';
import { sourceHealth } from './services/sources.mjs';
import { loadProductionModel, resetModelCache } from './ml/production-model.mjs';
import { getPool } from './lib/pool.mjs';
import { toLatLng } from './services/terrain.mjs';

export const api = express.Router();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).then((v) => { if (!res.headersSent) res.json(v); }).catch((e) => {
  console.error(`[api] ${req.method} ${req.originalUrl}:`, e.message);
  res.status(e.status || 500).json({ error: e.message });
});
const mineOr404 = (id) => { const m = MINE_BY_ID[id]; if (!m) throw Object.assign(new Error(`unknown mine ${id}`), { status: 404 }); return m; };
const round = (v, d = 0) => (v == null ? null : +(+v).toFixed(d));
const lastDate = () => get('SELECT MAX(date) d FROM daily_ops').d;

// ---- meta ----------------------------------------------------------------------------------------
api.get('/health', wrap(() => ({ ok: true, as_of: lastDate(), model: loadProductionModel()?.version, time: new Date().toISOString() })));

api.get('/meta', wrap(() => {
  const last = lastDate();
  return {
    as_of: last, fy: fiscalYear(addDays(last, 1)), model_version: loadProductionModel()?.version, seeded_at: getMeta('seeded_at'), last_ingest_at: getMeta('last_ingest_at'),
    economics: ECONOMICS,
    mines: MINES.map((m) => ({ id: m.id, name: m.name, district: m.district, state: m.state, lat: m.lat, lng: m.lng, method: m.method, method_label: m.methodLabel, annual_plan_t: m.annualPlanT, grade_mn: m.gradeMn, shifts: m.shifts })),
  };
}));

// ---- portfolio overview --------------------------------------------------------------------------
api.get('/overview', wrap(async () => {
  const last = lastDate(), fy = fiscalYear(addDays(last, 1));
  const [pf, live] = await Promise.all([portfolioForecast(), liveForecast()]);
  const res = await Promise.all(MINES.map((m) => resources(m.id).catch(() => null)));
  const mines = MINES.map((m, i) => {
    const fc = pf.mines[m.id];
    const d30 = get('SELECT SUM(plan_t) p, SUM(actual_t) a, AVG(fleet_avail) av, SUM(unplanned_down_h) dh FROM daily_ops WHERE mine_id = ? AND date > ?', m.id, addDays(last, -30));
    const fytd = get('SELECT SUM(plan_t) p, SUM(actual_t) a FROM daily_ops WHERE mine_id = ? AND date >= ?', m.id, fy.start);
    const today = get('SELECT rom_stock_t, plan_t, grade_mn FROM daily_ops WHERE mine_id = ? AND date = ?', m.id, last);
    const alerts = mineAlerts(m.id, fc);
    const r = res[i]?.summary;
    const drag = fc.attribution?.groups?.[0];
    return {
      id: m.id, name: m.name, district: m.district, state: m.state, lat: m.lat, lng: m.lng, method: m.method, method_label: m.methodLabel, annual_plan_t: m.annualPlanT,
      fytd: { plan: round(fytd.p), actual: round(fytd.a), attainment: round(fytd.a / fytd.p, 4) },
      last30: { plan: round(d30.p), actual: round(d30.a), attainment: round(d30.a / d30.p, 4), fleet_avail: round(d30.av, 4), downtime_h: round(d30.dh) },
      next4: fc.next4, next13: fc.next13, fy: fc.fy, top_drag: drag ? { group: drag.group, tonnes: drag.tonnes } : null,
      rom_days: today ? round(today.rom_stock_t / (today.plan_t * 0.93), 1) : null, grade_mn: round(today?.grade_mn, 2),
      reserves: r ? { reserves_t: r.reserves.tonnes, reserves_grade: r.reserves.grade, resources_t: r.resources.tonnes, resources_grade: r.resources.grade, life_years: r.mine_life_years } : null,
      alerts: { total: alerts.length, critical: alerts.filter((a) => a.severity === 'Critical').length, high: alerts.filter((a) => a.severity === 'High').length },
      risk: fc.next4.p_shortfall_5pct >= 0.7 ? 'High' : fc.next4.p_shortfall_5pct >= 0.4 ? 'Medium' : 'Low',
      weather7: (live?.data?.[m.id] || []).filter((d) => d.date > last).slice(0, 7).map((d) => ({ date: d.date, rain_mm: d.rain_mm, tmax_c: d.tmax_c, rain_prob: d.rain_prob })),
    };
  });
  const allAlerts = MINES.flatMap((m) => mineAlerts(m.id, pf.mines[m.id]));
  const sevRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  allAlerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.impact_t - a.impact_t);
  const sum = (f) => mines.reduce((s, m) => s + (f(m) || 0), 0);
  return {
    as_of: last, fy, weather_live: !!live?.data, weather_fetched_at: live?.fetched_at || null, portfolio: pf.portfolio, mines,
    kpis: {
      reserves_t: round(sum((m) => m.reserves?.reserves_t)), resources_t: round(sum((m) => m.reserves?.resources_t)),
      fytd_plan: round(sum((m) => m.fytd.plan)), fytd_actual: round(sum((m) => m.fytd.actual)),
      fleet_avail: round(mines.reduce((s, m) => s + m.last30.fleet_avail * m.annual_plan_t, 0) / sum((m) => m.annual_plan_t), 4),
      alerts: { total: allAlerts.length, critical: allAlerts.filter((a) => a.severity === 'Critical').length, high: allAlerts.filter((a) => a.severity === 'High').length },
    },
    alerts: allAlerts.slice(0, 12),
  };
}));

// ---- production history -------------------------------------------------------------------------
function aggregate(rows, grain) {
  const key = (d) => (grain === 'month' ? d.slice(0, 7) : grain === 'week' ? weekStart(d) : d);
  const out = new Map();
  for (const r of rows) {
    const k = key(r.date);
    const a = out.get(k) || { period: k, plan: 0, actual: 0, dispatch: 0, rain: 0, days: 0, avail: 0, down: 0, blasts_p: 0, blasts_d: 0, grade: 0, rom: 0, flood: 0 };
    a.plan += r.plan_t; a.actual += r.actual_t; a.dispatch += r.dispatch_t; a.rain += r.rain_mm; a.days++; a.avail += r.fleet_avail; a.down += r.unplanned_down_h;
    a.blasts_p += r.blasts_planned; a.blasts_d += r.blasts_done; a.grade += r.grade_mn * r.actual_t; a.rom = r.rom_stock_t; a.flood += r.flood_loss;
    out.set(k, a);
  }
  return [...out.values()].map((a) => ({ period: a.period, plan: round(a.plan), actual: round(a.actual), dispatch: round(a.dispatch), attainment: round(a.actual / a.plan, 4), rain_mm: round(a.rain, 1),
    fleet_avail: round(a.avail / a.days, 4), downtime_h: round(a.down), blast_exec: round(a.blasts_d / Math.max(1, a.blasts_p), 3), grade_mn: round(a.grade / Math.max(1, a.actual), 2), rom_t: round(a.rom), flood: round(a.flood / a.days, 3), days: a.days }));
}

api.get('/production', wrap((req) => {
  const grain = req.query.grain || 'month', days = +(req.query.days || 540);
  const from = addDays(lastDate(), -days);
  const rows = all(`SELECT date, SUM(plan_t) plan_t, SUM(actual_t) actual_t, SUM(dispatch_t) dispatch_t, AVG(rain_mm) rain_mm, AVG(fleet_avail) fleet_avail, SUM(unplanned_down_h) unplanned_down_h,
    SUM(blasts_planned) blasts_planned, SUM(blasts_done) blasts_done, SUM(grade_mn * actual_t) / SUM(actual_t) grade_mn, SUM(rom_stock_t) rom_stock_t, AVG(flood_loss) flood_loss FROM daily_ops WHERE date > ? GROUP BY date ORDER BY date`, from);
  return { grain, series: aggregate(rows, grain) };
}));

api.get('/mines/:id/production', wrap((req) => {
  mineOr404(req.params.id);
  const grain = req.query.grain || 'week', days = +(req.query.days || 365);
  const rows = all('SELECT * FROM daily_ops WHERE mine_id = ? AND date > ? ORDER BY date', req.params.id, addDays(lastDate(), -days));
  const recent = rows.slice(-14).map((r) => ({ date: r.date, plan: round(r.plan_t), actual: round(r.actual_t), attainment: round(r.actual_t / r.plan_t, 3), fleet_avail: r.fleet_avail, downtime_h: r.unplanned_down_h,
    blasts: `${r.blasts_done}/${r.blasts_planned}`, rain_mm: r.rain_mm, soil_moisture: r.soil_moisture, tmax_c: r.tmax_c, flood: r.flood_loss, shift_hours: r.shift_hours, bottleneck: r.bottleneck, grade_mn: r.grade_mn, rom_t: round(r.rom_stock_t), dispatch: round(r.dispatch_t) }));
  const bottlenecks = all('SELECT bottleneck, COUNT(*) n, SUM(plan_t - actual_t) lost FROM daily_ops WHERE mine_id = ? AND date > ? GROUP BY bottleneck ORDER BY lost DESC', req.params.id, addDays(lastDate(), -days));
  return { mine_id: req.params.id, grain, series: aggregate(rows, grain), recent, bottlenecks };
}));

// ---- forecast, risk, actions -------------------------------------------------------------------------
api.get('/mines/:id/forecast', wrap(async (req) => { mineOr404(req.params.id); return forecast(req.params.id); }));
api.get('/portfolio/forecast', wrap(async () => portfolioForecast()));
api.get('/mines/:id/alerts', wrap(async (req) => { mineOr404(req.params.id); return mineAlerts(req.params.id, await forecast(req.params.id)); }));
api.get('/alerts', wrap(async () => {
  const pf = await portfolioForecast();
  const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  return MINES.flatMap((m) => mineAlerts(m.id, pf.mines[m.id])).sort((a, b) => rank[a.severity] - rank[b.severity] || b.impact_t - a.impact_t);
}));
api.get('/risk', wrap(async () => {
  const pf = await portfolioForecast();
  return { portfolio: pf.portfolio, mines: MINES.map((m) => {
    const f = pf.mines[m.id];
    return { id: m.id, name: m.name, method: m.method, next4: f.next4, next13: f.next13, fy: f.fy, attribution: f.attribution,
      weeks: f.weeks.map((w) => ({ start: w.start, plan: w.plan, p50: w.p50, p_below_90: w.p_below_90, p_below_plan: w.p_below_plan })) };
  }) };
}));
api.get('/mines/:id/actions', wrap(async (req) => { mineOr404(req.params.id); return actionPlan(req.params.id); }));
api.post('/mines/:id/simulate', express.json(), wrap(async (req) => {
  const m = mineOr404(req.params.id), b = req.body || {};
  const scenario = {};
  if (b.wx && b.wx !== 'forecast') scenario.wx = b.wx;
  if (b.shiftH) scenario.shiftH = +b.shiftH;
  if (b.availUplift) scenario.availUplift = +b.availUplift;
  if (b.pumpBoost) scenario.pumpBoostM3h = +b.pumpBoost * m.water.pumpM3h;
  if (b.blastMitigation) scenario.rainBlastMitigation = +b.blastMitigation;
  if (b.fragImprove) scenario.fragImprove = +b.fragImprove;
  if (b.supplyBuffer) scenario.supplyBuffer = true;
  if (b.pmCompliance) scenario.pmDeferralRate = 0.05;
  if (b.criticalSpares) scenario.mttrMultCritical = 0.55;
  if (b.extraUnits?.length) scenario.extraUnits = b.extraUnits.filter((x) => EQUIPMENT_CLASSES[x.cls] && x.count > 0).map((x) => ({ cls: x.cls, count: Math.min(6, +x.count), fromDay: +(x.fromDay ?? 5) }));
  if (b.actions?.length) {        // apply a subset of optimiser actions
    const plan = await actionPlan(req.params.id);
    for (const a of plan.actions.filter((x) => b.actions.includes(x.id))) {
      for (const [k, v] of Object.entries(a.scenario)) {
        if (k === 'pmNow') scenario.pmNow = [...new Set([...(scenario.pmNow || []), ...v])];
        else if (k === 'extraUnits') scenario.extraUnits = [...(scenario.extraUnits || []), ...v];
        else if (k === 'from' || k === 'until') scenario[k] = { ...(scenario[k] || {}), ...v };
        else scenario[k] = v;
      }
    }
  }
  return simulateScenario(req.params.id, scenario);
}));

// ---- equipment & blasting -------------------------------------------------------------------------
api.get('/mines/:id/equipment', wrap((req) => { mineOr404(req.params.id); return { ...fleetHealth(req.params.id), group_labels: GROUP_LABEL }; }));
api.get('/mines/:id/blasting', wrap((req) => {
  const m = mineOr404(req.params.id), last = lastDate(), from = addDays(last, -365);
  const reasons = all('SELECT reason, COUNT(*) n FROM blast_log WHERE mine_id = ? AND date > ? AND executed = 0 GROUP BY reason ORDER BY n DESC', m.id, from);
  const byRain = all(`SELECT CASE WHEN o.rain_mm < 2 THEN '0–2' WHEN o.rain_mm < 8 THEN '2–8' WHEN o.rain_mm < 20 THEN '8–20' WHEN o.rain_mm < 40 THEN '20–40' ELSE '≥40' END bucket,
    MIN(o.rain_mm) lo, COUNT(*) n, AVG(1.0 - b.executed) cancel_rate FROM blast_log b JOIN daily_ops o ON o.mine_id = b.mine_id AND o.date = b.date WHERE b.mine_id = ? GROUP BY bucket ORDER BY lo`, m.id);
  const recent = all('SELECT date, executed, delay_h, reason, fragmentation FROM blast_log WHERE mine_id = ? ORDER BY date DESC, id DESC LIMIT 30', m.id);
  const weekly = aggregate(all('SELECT * FROM daily_ops WHERE mine_id = ? AND date > ? ORDER BY date', m.id, addDays(last, -182)), 'week').map((w) => ({ period: w.period, blast_exec: w.blast_exec, rain_mm: w.rain_mm }));
  return { mine_id: m.id, reasons, by_rain: byRain.map((r) => ({ ...r, cancel_rate: round(r.cancel_rate, 3) })), recent, weekly };
}));

// ---- reserves ------------------------------------------------------------------------------------------
api.get('/mines/:id/reserves', wrap(async (req) => {
  mineOr404(req.params.id);
  const { panels, pierce, ...rest } = await resources(req.params.id);
  return { ...rest, pierce_count: pierce.length };
}));
api.get('/mines/:id/reserves/scene', wrap(async (req) => { mineOr404(req.params.id); return reserveScene(req.params.id); }));
api.get('/mines/:id/boreholes', wrap((req) => {
  const m = mineOr404(req.params.id);
  return all('SELECT id, lat, lng, collar_z, azimuth, dip, depth_m, drilled_on, purpose FROM boreholes WHERE mine_id = ? ORDER BY id', m.id);
}));
api.get('/boreholes/:id', wrap(async (req) => { const r = await boreholeLog(req.params.id); if (!r) throw Object.assign(new Error('no such hole'), { status: 404 }); return r; }));
api.get('/mines/:id/geology', wrap(async (req) => {
  // surface expression for the exploration map: lode traces, lease, proposed holes (lat/lng)
  const m = mineOr404(req.params.id);
  const r = await resources(m.id);
  const f = r.frame, half = f.strike_len_m / 2;
  const trace = (lens) => {
    const L = f.lenses.find((x) => x.id === lens), o = [f.origin[0] + f.n[0] * L.offset, f.origin[1] + f.n[1] * L.offset];
    return [-half, half].map((u) => { const ll = toLatLng(m, o[0] + f.s[0] * u, o[1] + f.s[1] * u); return [ll.lat, ll.lng]; });
  };
  const lease = [[-half - 250, -350], [half + 250, -350], [half + 250, 1100], [-half - 250, 1100]].map(([u, h]) => {
    const e = f.origin[0] + f.s[0] * u + Math.sin((f.dipDirAz * Math.PI) / 180) * h, n = f.origin[1] + f.s[1] * u + Math.cos((f.dipDirAz * Math.PI) / 180) * h;
    const ll = toLatLng(m, e, n); return [ll.lat, ll.lng];
  });
  return { mine_id: m.id, strike_az: f.strikeAz, dip: f.dipDeg, dip_dir: f.dipDirAz, traces: f.lenses.map((L) => ({ lens: L.id, name: L.name, line: trace(L.id) })), lease, proposals: r.proposals };
}));

// ---- weather ----------------------------------------------------------------------------------------------
api.get('/weather/live', wrap(async () => { const l = await liveForecast(); return { fetched_at: l.fetched_at || null, error: l.error || null, mines: l.data || {} }; }));
api.get('/mines/:id/weather', wrap((req) => {
  const m = mineOr404(req.params.id), last = lastDate();
  const hist = all('SELECT date, rain_mm, tmax_c, soil_moisture, soil_temp_c, source FROM weather_daily WHERE mine_id = ? AND date > ? ORDER BY date', m.id, addDays(last, -120));
  const clim = all("SELECT CAST(substr(date, 6, 2) AS INTEGER) month, SUM(rain_mm) / COUNT(DISTINCT substr(date, 1, 4)) rain_mm, AVG(tmax_c) tmax_c, AVG(soil_moisture) sm FROM weather_daily WHERE mine_id = ? AND date < ? GROUP BY month ORDER BY month", m.id, `${last.slice(0, 4)}-01-01`);
  return { mine_id: m.id, history: hist, climatology: clim.map((c) => ({ month: c.month, rain_mm: round(c.rain_mm), tmax_c: round(c.tmax_c, 1), soil_moisture: round(c.sm, 3) })) };
}));

// ---- data sources, models, import -------------------------------------------------------------------------
api.get('/sources', wrap(() => sourceHealth()));
api.get('/models', wrap(() => {
  const pm = loadProductionModel();
  let prosp = null;
  try { prosp = JSON.parse(fs.readFileSync(path.join(ROOT, 'ml', 'metrics.json'), 'utf8')); } catch { /* optional */ }
  return {
    production: pm && { name: pm.name, title: pm.title, version: pm.version, trained_at: pm.trained_at, target: pm.target, features: FEATURES, training: pm.training, metrics: pm.metrics, per_mine: pm.per_mine, importance: pm.importance, backtest: pm.backtest, residuals: pm.residuals },
    prospectivity: prosp,
    registry: all('SELECT name, version, trained_at, active, metrics_json FROM model_registry ORDER BY trained_at DESC LIMIT 10').map((r) => ({ ...r, metrics: JSON.parse(r.metrics_json), metrics_json: undefined })),
  };
}));
api.post('/models/production/retrain', wrap(async () => {
  const r = await getPool().run({ task: 'train' });
  resetModelCache(); clearForecastCache(); getPool().broadcast({ type: 'reload' });
  return r;
}));

/** CSV import of MOIL daily production: mine_id,date,actual_t[,plan_t,dispatch_t,grade_mn] → updates existing days. */
api.post('/import/production', express.text({ type: '*/*', limit: '20mb' }), wrap((req) => {
  const text = String(req.body || '').trim();
  const [head, ...lines] = text.split(/\r?\n/);
  const cols = head.split(',').map((c) => c.trim().toLowerCase());
  for (const need of ['mine_id', 'date', 'actual_t']) if (!cols.includes(need)) throw Object.assign(new Error(`CSV must contain column "${need}"`), { status: 400 });
  const allowed = ['actual_t', 'plan_t', 'dispatch_t', 'grade_mn'];
  let updated = 0, skipped = 0;
  const errors = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    const v = Object.fromEntries(line.split(',').map((x, k) => [cols[k], x.trim()]));
    if (!MINE_BY_ID[v.mine_id] || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) { skipped++; if (errors.length < 5) errors.push(`line ${i + 2}: bad mine_id/date`); continue; }
    const sets = allowed.filter((c) => v[c] != null && v[c] !== '' && Number.isFinite(+v[c]));
    if (!sets.length) { skipped++; continue; }
    const r = run(`UPDATE daily_ops SET ${sets.map((c) => `${c} = ?`).join(', ')}, source = 'MOIL upload' WHERE mine_id = ? AND date = ?`, ...sets.map((c) => +v[c]), v.mine_id, v.date);
    if (r.changes) updated++; else { skipped++; if (errors.length < 5) errors.push(`line ${i + 2}: no operating day ${v.mine_id} ${v.date}`); }
  }
  insertMany('imports', [{ at: new Date().toISOString(), kind: 'production', filename: req.get('x-filename') || 'upload.csv', rows: updated, detail: JSON.stringify({ skipped, errors }) }]);
  clearForecastCache();
  return { updated, skipped, errors, next: 'POST /api/models/production/retrain to retrain the model on the imported data' };
}));

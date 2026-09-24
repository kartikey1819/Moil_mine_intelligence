/* Production-attainment model: weekly (actual / plan) as a function of operating constraints.
 *
 *   dataset   7-day blocks per mine from daily_ops (equipment, blasting, weather, water, power, roster)
 *   model     gradient-boosted trees (server/ml/gbm.mjs), exact TreeSHAP via public/js/ml-runtime.js
 *   validation  time-based hold-out (last 26 weeks, all mines) vs two baselines MOIL could use today:
 *               "plan will be met" and "last 4 weeks' attainment persists"
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { all, run, get, DATA_DIR } from '../lib/db.mjs';
import { addDays } from '../lib/dates.mjs';
import { MINE_BY_ID } from '../config/mines.mjs';
import { FEATURES, FEATURE_NAMES, weekFeatures } from '../sim/mine-sim.mjs';
import { trainGBM } from './gbm.mjs';

const require = createRequire(import.meta.url);
export const RT = require('../../public/js/ml-runtime.js');
const MODEL_DIR = path.join(DATA_DIR, 'models');
export const MODEL_NAME = 'production-attainment-gbm';

export function rowToDriver(row) {
  return {
    day: row.date, planDay: row.plan_t,
    avail: { loading: row.avail_loading, haulage: row.avail_haulage, hoisting: row.avail_hoisting, crushing: row.avail_crushing, drilling: row.avail_drilling },
    critDown: row.crit_down_h, planned: row.blasts_planned, done: row.blasts_done, delay: row.blast_delay_h, poorFrag: row.poor_frag,
    wx: { rain_mm: row.rain_mm, soil_moisture: row.soil_moisture, tmax_c: row.tmax_c },
    flood: row.flood_loss, inflow: row.inflow_m3h, pumpCap: row.pump_cap_m3h, outage: row.outage_h, shiftH: row.shift_hours,
  };
}

/** Weekly blocks for one mine, aligned to its first day of history. */
export function weeklyBlocks(mineId, { from = null } = {}) {
  const mine = MINE_BY_ID[mineId];
  const rows = all('SELECT * FROM daily_ops WHERE mine_id = ? ORDER BY date', mineId);
  const out = [];
  let mtdPlan = 0, mtdAct = 0, month = null;
  const mtd = [];               // backlog before each day
  rows.forEach((r) => { const m = r.date.slice(0, 7); if (m !== month) { month = m; mtdPlan = 0; mtdAct = 0; } mtd.push(Math.max(0, mtdPlan - mtdAct)); mtdPlan += r.plan_t; mtdAct += r.actual_t; });
  for (let i = 0; i + 7 <= rows.length; i += 7) {
    const blk = rows.slice(i, i + 7);
    if (from && blk[0].date < from) continue;
    const prev = rows[i - 1] || rows[i];
    const planDay0 = blk[0].plan_t;
    const f = weekFeatures(blk.map(rowToDriver), { mine, stockDays0: prev.broken_stock_t / planDay0, backlogDays0: mtd[i] / planDay0 });
    const plan = blk.reduce((s, r) => s + r.plan_t, 0), actual = blk.reduce((s, r) => s + r.actual_t, 0);
    out.push({ mine_id: mineId, start: blk[0].date, end: blk[6].date, plan, actual, attainment: actual / plan, features: f, x: FEATURE_NAMES.map((k) => f[k]) });
  }
  return out;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

export function trainProductionModel({ holdoutWeeks = 26, log = console.log } = {}) {
  const mines = all('SELECT id FROM mines').map((r) => r.id);
  const data = mines.flatMap((id) => weeklyBlocks(id));
  const lastStart = data.reduce((m, r) => (r.start > m ? r.start : m), '');
  const cutoff = addDays(lastStart, -7 * (holdoutWeeks - 1));
  const train = data.filter((r) => r.start < cutoff), test = data.filter((r) => r.start >= cutoff);
  log(`[ml] weekly rows: ${data.length} (train ${train.length}, hold-out ${test.length} from ${cutoff})`);

  const t0 = performance.now();
  const monotone = FEATURES.map((f) => f.mono || 0);
  const booster = trainGBM(train.map((r) => r.x), train.map((r) => r.attainment), { monotone });
  const trainMs = Math.round(performance.now() - t0);

  // --- evaluation on the hold-out ---------------------------------------------------------------
  const byMineHist = Object.fromEntries(mines.map((id) => [id, data.filter((r) => r.mine_id === id)]));
  const evalRows = test.map((r) => {
    const hist = byMineHist[r.mine_id].filter((h) => h.end < r.start).slice(-4);
    const persist = mean(hist.map((h) => h.attainment));
    const pred = RT.margin(booster, r.x);
    return { ...r, pred, persist };
  });
  const score = (key) => {
    const errT = evalRows.map((r) => (r[key] - r.attainment) * r.plan);
    const ssRes = evalRows.reduce((s, r) => s + (r[key] - r.attainment) ** 2, 0);
    const mu = mean(evalRows.map((r) => r.attainment)), ssTot = evalRows.reduce((s, r) => s + (r.attainment - mu) ** 2, 0);
    return {
      mae_t: Math.round(mean(errT.map(Math.abs))), mape_pct: +(mean(evalRows.map((r) => Math.abs(r[key] - r.attainment) / r.attainment)) * 100).toFixed(2),
      bias_t: Math.round(mean(errT)), r2: +(1 - ssRes / ssTot).toFixed(3),
    };
  };
  evalRows.forEach((r) => { r.plan1 = 1; });
  const metrics = { model: score('pred'), baseline_plan: score('plan1'), baseline_persistence: score('persist') };
  const perMine = Object.fromEntries(mines.map((id) => {
    const rs = evalRows.filter((r) => r.mine_id === id), res = rs.map((r) => r.attainment - r.pred);
    return [id, { mae_t: Math.round(mean(rs.map((r) => Math.abs(r.pred - r.attainment) * r.plan))), resid_sd: +Math.sqrt(mean(res.map((v) => v * v))).toFixed(4) }];
  }));
  const shapAbs = new Array(FEATURE_NAMES.length).fill(0);
  evalRows.forEach((r) => RT.shap(booster, r.x).forEach((v, j) => { shapAbs[j] += Math.abs(v) / evalRows.length; }));
  const importance = FEATURES.map((f, j) => ({ feature: f.name, label: f.label, group: f.group, mean_abs_shap: +shapAbs[j].toFixed(5) })).sort((a, b) => b.mean_abs_shap - a.mean_abs_shap);
  const residuals = evalRows.map((r) => +(r.attainment - r.pred).toFixed(4));

  // --- final model on all data ------------------------------------------------------------------
  const final = trainGBM(data.map((r) => r.x), data.map((r) => r.attainment), { monotone });
  const trainedAt = new Date().toISOString();
  const version = trainedAt.slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1.$2');
  const model = {
    name: MODEL_NAME, title: 'Production-attainment model (gradient-boosted trees)', version, trained_at: trainedAt,
    target: 'weekly actual ÷ planned tonnes', features: FEATURES, booster: final,
    training: { rows: data.length, mines: mines.length, from: data[0]?.start, to: lastStart, holdout_from: cutoff, holdout_rows: test.length, train_ms: trainMs, params: booster.params },
    metrics, per_mine: perMine, importance, residuals,
    backtest: evalRows.map((r) => ({ mine_id: r.mine_id, start: r.start, plan: Math.round(r.plan), actual: Math.round(r.actual), predicted: Math.round(r.pred * r.plan), persistence: Math.round(r.persist * r.plan) })),
  };
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const file = path.join(MODEL_DIR, `${MODEL_NAME}-${version}.json`);
  fs.writeFileSync(file, JSON.stringify(model));
  run('UPDATE model_registry SET active = 0 WHERE name = ?', MODEL_NAME);
  run('INSERT OR REPLACE INTO model_registry (name, version, trained_at, metrics_json, path, active) VALUES (?, ?, ?, ?, ?, 1)',
    MODEL_NAME, version, trainedAt, JSON.stringify({ metrics, training: model.training }), path.relative(DATA_DIR, file));
  cached = model;
  log(`[ml] hold-out MAE ${metrics.model.mae_t} t/wk (plan-baseline ${metrics.baseline_plan.mae_t}, persistence ${metrics.baseline_persistence.mae_t}) · R² ${metrics.model.r2}`);
  return model;
}

let cached = null;
export function loadProductionModel() {
  if (cached) return cached;
  const row = get('SELECT path FROM model_registry WHERE name = ? AND active = 1', MODEL_NAME);
  if (!row) return null;
  cached = JSON.parse(fs.readFileSync(path.join(DATA_DIR, row.path), 'utf8'));
  return cached;
}
export const resetModelCache = () => { cached = null; };

/** Flatten all trees into typed arrays (thresholds pre-rounded to float32, as the runtime compares). */
function compile(booster) {
  const n = booster.trees.reduce((s, t) => s + t.f.length, 0);
  const F = new Int16Array(n), T = new Float32Array(n), L = new Int32Array(n), R = new Int32Array(n), V = new Float64Array(n), roots = new Int32Array(booster.trees.length);
  let off = 0;
  booster.trees.forEach((t, k) => {
    roots[k] = off;
    for (let j = 0; j < t.f.length; j++) { F[off + j] = t.f[j]; T[off + j] = t.t[j]; L[off + j] = off + t.l[j]; R[off + j] = off + t.r[j]; V[off + j] = t.v[j]; }
    off += t.f.length;
  });
  return { F, T, L, R, V, roots, base: booster.base_margin };
}
const compiled = new WeakMap();
const x32 = new Float32Array(FEATURE_NAMES.length);
export function predictAttainment(model, f) {
  let c = compiled.get(model);
  if (!c) { c = compile(model.booster); compiled.set(model, c); }
  for (let i = 0; i < FEATURE_NAMES.length; i++) x32[i] = f[FEATURE_NAMES[i]];
  return evalCompiled(c, x32);
}
function evalCompiled(c, x) {
  const F = c.F, T = c.T, L = c.L, R = c.R, V = c.V, roots = c.roots, nT = roots.length;
  let s = c.base;
  for (let k = 0; k < nT; k++) {
    let j = roots[k], fj = F[j];
    while (fj >= 0) { j = x[fj] < T[j] ? L[j] : R[j]; fj = F[j]; }
    s += V[j];
  }
  return s;
}
export const explainAttainment = (model, f) => RT.shap(model.booster, FEATURE_NAMES.map((k) => f[k]));

/* Probabilistic production forecast (Monte-Carlo × ML).
 *
 * For each simulation path:
 *   weather   days 1–16: live forecast (Open-Meteo) with growing rainfall uncertainty;
 *             beyond: the same calendar days of a sampled historical year (ERA5, 2015→). The year index is
 *             shared by all mines in a path, so regional weather stays correlated across the portfolio.
 *   drivers   equipment failures (reliability fitted from the log), blasting, mine water, power, roster —
 *             server/sim/mine-sim.mjs stepDrivers()
 *   output    weekly attainment from the trained ML model + residual noise (hold-out residual spread),
 *             with blasted-ore inventory and month-to-date backlog carried from week to week.
 * Result: P10/P50/P90 per week, shortfall probabilities, FY outlook and a TreeSHAP decomposition of the gap.
 */
import { all, get, getMeta } from '../lib/db.mjs';
import { Rng, mulberry32, mixSeed } from '../lib/rng.mjs';
import { addDays, daysBetween, fiscalYear, todayIST } from '../lib/dates.mjs';
import { MINE_BY_ID, MINES, EQUIPMENT_CLASSES } from '../config/mines.mjs';
import { FEATURES, FEATURE_NAMES, planForDay, stepDrivers, weekFeatures, makeUnit } from '../sim/mine-sim.mjs';
import { restoreState } from '../seed/operations.mjs';
import { loadProductionModel, predictAttainment, explainAttainment } from '../ml/production-model.mjs';
import { liveForecast, weatherMap } from './weather.mjs';
import { fittedUnitRows } from './equipment.mjs';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b = 0, c = 0, d = 0) => mixSeed(a, b, c, d);
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const quant = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
const round = (v, d = 0) => +(+v).toFixed(d);

// ---- context (per mine, cached per data/model/weather version) --------------------------------
const ctxCache = new Map();
function context(mineId, live) {
  const last = get('SELECT MAX(date) d FROM daily_ops WHERE mine_id = ?', mineId).d;
  const model = loadProductionModel();
  const key = `${mineId}|${last}|${model?.version}|${live?.fetched_at}`;
  if (ctxCache.has(key)) return ctxCache.get(key);
  const mine = MINE_BY_ID[mineId];
  const units = fittedUnitRows(mineId);
  const stateJson = getMeta(`simstate:${mineId}`);
  const wx = weatherMap(mineId, '2015-01-01');
  const years = [...new Set([...wx.keys()].map((d) => +d.slice(0, 4)))].filter((y) => wx.has(`${y}-12-31`) || y < +last.slice(0, 4)).sort();
  const lastWx = [...wx.values()].pop();
  const liveDays = new Map((live?.data?.[mineId] || []).map((r) => [r.date, r]));
  const residSd = model?.per_mine?.[mineId]?.resid_sd ?? 0.05;
  const hist = all('SELECT date, plan_t, actual_t FROM daily_ops WHERE mine_id = ? AND date >= ? ORDER BY date', mineId, fiscalYear(addDays(last, 1)).start);
  const ctx = { key, mine, units, stateJson, wx, years, lastWx, liveDays, residSd, last, start: addDays(last, 1), model, fyHist: hist };
  ctxCache.clear(); ctxCache.set(key, ctx);   // keep memory bounded: only the latest context per call pattern
  return ctx;
}

function weatherFor(ctx, day, k, year, wrng, mode) {
  const live = ctx.liveDays.get(day);
  let w;
  if (live && live.rain_mm != null && mode !== 'dry' && mode !== 'wet') {
    const spread = k < 3 ? 0.12 : k < 7 ? 0.35 : 0.6;               // forecast skill decays with lead time
    w = { rain_mm: live.rain_mm * wrng.lognormal(1, spread), tmax_c: live.tmax_c + wrng.normal(0, k < 7 ? 0.8 : 1.6), soil_moisture: live.soil_moisture ?? ctx.lastWx.soil_moisture, live: true };
  } else {
    let md = day.slice(4); if (md === '-02-29') md = '-02-28';
    const h = ctx.wx.get(`${year}${md}`) || ctx.lastWx;
    w = { rain_mm: h.rain_mm, tmax_c: h.tmax_c, soil_moisture: h.soil_moisture, live: false };
  }
  if (mode === 'dry') { w.rain_mm *= 0.25; w.soil_moisture = Math.max(0.12, w.soil_moisture * 0.8); }
  if (mode === 'wet') { w.rain_mm *= 1.7; w.soil_moisture = Math.min(0.5, w.soil_moisture * 1.15); }
  return w;
}

function buildMod(scenario) {
  const m = {};
  for (const k of ['shiftH', 'availUplift', 'pumpBoostM3h', 'rainBlastMitigation', 'supplyBuffer', 'fragImprove', 'mttrMultCritical', 'pmDeferralRate', 'from', 'until']) if (scenario[k] != null) m[k] = scenario[k];
  return m;
}

/** Monte-Carlo forecast for one mine. Returns per-simulation weekly tonnes (for portfolio sums) + summary. */
export function simulateMine(mineId, scenario = {}, { sims = 240, horizonWeeks = null, live = null } = {}) {
  const ctx = context(mineId, live);
  const { mine, model } = ctx;
  if (!model) throw new Error('production model not trained — run npm run seed');
  const fy = fiscalYear(ctx.start);
  const H = horizonWeeks ?? clamp(Math.ceil((daysBetween(ctx.start, fy.end) + 1) / 7), 13, 27);
  const nDays = H * 7;
  const days = Array.from({ length: nDays }, (_, k) => addDays(ctx.start, k));
  const planDays = days.map((d) => planForDay(mine, d));
  const weekPlan = Array.from({ length: H }, (_, w) => planDays.slice(w * 7, w * 7 + 7).reduce((s, v) => s + v, 0));
  const mod0 = buildMod(scenario);
  const seedBase = strHash(scenario.seed || 'base');
  const prod = Array.from({ length: H }, () => new Float64Array(sims));
  const featSum = Array.from({ length: H }, () => Object.fromEntries(FEATURE_NAMES.map((f) => [f, 0])));

  // opening month-to-date position
  const monthStart = ctx.start.slice(0, 8) + '01';
  const mtd = ctx.fyHist.filter((r) => r.date >= monthStart);
  const mtdPlan0 = mtd.reduce((s, r) => s + r.plan_t, 0), mtdAct0 = mtd.reduce((s, r) => s + r.actual_t, 0);

  const hashes = new Map();
  const hashOf = (id) => { let h = hashes.get(id); if (h === undefined) { h = strHash(id); hashes.set(id, h); } return h; };
  const ur = new Rng(0), dr = new Rng(0);
  for (let s = 0; s < sims; s++) {
    const st = restoreState(mine, ctx.units, ctx.stateJson);
    // --- scenario set-up on this path's fleet
    if (scenario.pmNow?.length) st.units.forEach((u) => { if (scenario.pmNow.includes(u.id)) { u.hsp = 0; u.down = Math.max(u.down, 8); u.pmDefer = 1; } });
    (scenario.removeUnits || []).forEach((x) => { st.units.filter((u) => u.cls === x.cls && !u.removedFrom).slice(0, x.count).forEach((u) => { u.removedFrom = x.fromDay; }); });
    const extra = (scenario.extraUnits || []).map((x, i) => ({ fromDay: x.fromDay, toDay: x.toDay, units: Array.from({ length: x.count }, (_, j) => makeUnit({ id: `X${i}-${x.cls}-${j}`, class: x.cls, hours_since_pm: 0, mtbf_h: EQUIPMENT_CLASSES[x.cls].mtbf * (x.mtbfFactor || 1) })) }));
    const mod = { ...mod0, extraUnits: extra };

    const year = ctx.years[mulberry32(mix(s, 7331))() * ctx.years.length | 0];
    const wrng = new Rng(mix(s, strHash(mineId), 17));
    const rrng = new Rng(mix(s, strHash(mineId), seedBase, 99));
    let mtdPlan = mtdPlan0, mtdAct = mtdAct0, month = ctx.start.slice(0, 7);
    for (let w = 0; w < H; w++) {
      const recs = [];
      for (let i = 0; i < 7; i++) {
        const k = w * 7 + i, day = days[k];
        const wx = weatherFor(ctx, day, k, year, wrng, scenario.wx);
        mod.dayIndex = k;
        mod.unitRng = (id) => ur.reseed(mix(s, k, hashOf(id), 4242));
        recs.push(stepDrivers(st, day, wx, dr.reseed(mix(s, k, 1, seedBase)), mod));
      }
      const pd0 = planDays[w * 7];
      const feat = weekFeatures(recs, { mine, stockDays0: st.brokenStock / pd0, backlogDays0: Math.max(0, mtdPlan - mtdAct) / pd0 });
      const att = Math.max(0, predictAttainment(model, feat) + rrng.normal(0, ctx.residSd));
      const out = att * weekPlan[w];
      prod[w][s] = out;
      const blasted = recs.reduce((a, d) => a + d.blasted, 0);
      st.brokenStock = clamp(st.brokenStock + blasted - out, 0, 8 * pd0);
      for (let i = 0; i < 7; i++) {
        const day = days[w * 7 + i];
        if (day.slice(0, 7) !== month) { month = day.slice(0, 7); mtdPlan = 0; mtdAct = 0; }
        mtdPlan += planDays[w * 7 + i]; mtdAct += out / 7;
      }
      for (const f of FEATURE_NAMES) featSum[w][f] += feat[f];
    }
  }

  const featMean = featSum.map((fs) => Object.fromEntries(Object.entries(fs).map(([k, v]) => [k, v / sims])));
  return { ctx, H, days, planDays, weekPlan, prod, featMean, sims, fy };
}

/** Distribution statistics shared by single-mine and portfolio forecasts. */
export function distSummary({ days, weekPlan, prod, sims, H, featMean = null, fy }) {
  const weeks = weekPlan.map((plan, w) => {
    const v = Array.from(prod[w]).sort((a, b) => a - b);
    const mean = v.reduce((s, x) => s + x, 0) / sims;
    return {
      week: w + 1, start: days[w * 7], end: days[w * 7 + 6], plan: round(plan), mean: round(mean), p10: round(quant(v, 0.1)), p50: round(quant(v, 0.5)), p90: round(quant(v, 0.9)),
      p_below_90: round(v.filter((x) => x < 0.9 * plan).length / sims, 3), p_below_plan: round(v.filter((x) => x < plan).length / sims, 3),
      ...(featMean ? { drivers: Object.fromEntries(Object.entries(featMean[w]).map(([k, x]) => [k, round(x, 3)])) } : {}),
    };
  });
  const window = (n) => {
    n = Math.min(n, H);
    const plan = weekPlan.slice(0, n).reduce((s, x) => s + x, 0);
    const tot = Array.from({ length: sims }, (_, s) => { let t = 0; for (let w = 0; w < n; w++) t += prod[w][s]; return t; }).sort((a, b) => a - b);
    const mean = tot.reduce((s, x) => s + x, 0) / sims;
    return { weeks: n, from: days[0], to: days[n * 7 - 1], plan: round(plan), mean: round(mean), p10: round(quant(tot, 0.1)), p50: round(quant(tot, 0.5)), p90: round(quant(tot, 0.9)),
      p_shortfall: round(tot.filter((x) => x < plan).length / sims, 3), p_shortfall_5pct: round(tot.filter((x) => x < 0.95 * plan).length / sims, 3),
      expected_shortfall: round(tot.reduce((s, x) => s + Math.max(0, plan - x), 0) / sims), expected_gap: round(plan - mean) };
  };
  const fyTot = Array.from({ length: sims }, (_, s) => { let t = fy.fytd_actual; for (let w = 0; w < fy.weeks; w++) t += prod[w][s]; return t; }).sort((a, b) => a - b);
  const fyOut = { label: fy.label, plan: round(fy.plan), fytd_plan: round(fy.fytd_plan), fytd_actual: round(fy.fytd_actual), p10: round(quant(fyTot, 0.1)), p50: round(quant(fyTot, 0.5)),
    p90: round(quant(fyTot, 0.9)), p_meet: round(fyTot.filter((x) => x >= fy.plan).length / sims, 3), expected_shortfall: round(fyTot.reduce((s, x) => s + Math.max(0, fy.plan - x), 0) / sims),
    covered_to: days[fy.weeks * 7 - 1] };
  return { weeks, next4: window(4), next13: window(13), fy: fyOut };
}

function fyInfo(sim) {
  const { ctx, H, fy } = sim;
  const fytdPlan = ctx.fyHist.reduce((s, r) => s + r.plan_t, 0), fytdAct = ctx.fyHist.reduce((s, r) => s + r.actual_t, 0);
  let rest = 0; for (let d = ctx.start; d <= fy.end; d = addDays(d, 1)) rest += planForDay(ctx.mine, d);
  return { label: fy.label, plan: fytdPlan + rest, fytd_plan: fytdPlan, fytd_actual: fytdAct, weeks: Math.min(H, Math.ceil((daysBetween(ctx.start, fy.end) + 1) / 7)) };
}

/** Full single-mine result (runs inside a worker). */
export function computeMine(mineId, scenario = {}, opts = {}) {
  const sim = simulateMine(mineId, scenario, opts);
  const { ctx, H, weekPlan, featMean } = sim;
  const fy = fyInfo(sim);
  const out = {
    mine_id: mineId, as_of: ctx.last, start: ctx.start, sims: sim.sims, horizon_weeks: H, model_version: ctx.model.version,
    weather_source: ctx.liveDays.size ? 'Live 16-day forecast (Open-Meteo) + ERA5 climatology' : 'ERA5 climatology (live forecast unavailable)',
    ...distSummary({ ...sim, fy }),
  };
  if (opts.detail !== false) {
    // TreeSHAP decomposition of the next-4-week forecast at mean simulated conditions
    const n = Math.min(4, H), groups = {};
    let base = 0, pred = 0;
    for (let w = 0; w < n; w++) {
      const phi = explainAttainment(ctx.model, featMean[w]);
      base += ctx.model.booster.expected_margin * weekPlan[w];
      pred += predictAttainment(ctx.model, featMean[w]) * weekPlan[w];
      FEATURES.forEach((f, j) => {
        const g = (groups[f.group] ||= { group: f.group, tonnes: 0, features: {} });
        g.tonnes += phi[j] * weekPlan[w];
        g.features[f.name] = (g.features[f.name] || 0) + phi[j] * weekPlan[w];
      });
    }
    const plan4 = weekPlan.slice(0, n).reduce((s, x) => s + x, 0);
    out.attribution = {
      horizon_weeks: n, plan: round(plan4), baseline: round(base), predicted_at_mean: round(pred), structural_gap: round(plan4 - base),
      note: 'TreeSHAP: the baseline is the model expectation for an average historical week; each driver moves the forecast up (+) or down (−) from it.',
      groups: Object.values(groups).filter((g) => g.group !== 'Mine').map((g) => ({ group: g.group, tonnes: round(g.tonnes),
        features: Object.entries(g.features).map(([k, v]) => ({ feature: k, label: FEATURES.find((f) => f.name === k).label, tonnes: round(v), value: round(featMean[0][k], 3) })).sort((a, b) => a.tonnes - b.tonnes) }))
        .sort((a, b) => a.tonnes - b.tonnes),
    };
    out.live_weather = [...ctx.liveDays.values()].filter((d) => d.date >= addDays(todayIST(), -2));
  }
  const raw = opts.returnPaths ? { days: sim.days, weekPlan, prod: sim.prod, fy } : null;
  return { summary: out, raw };
}

// ---- main-thread API: worker pool + cache ---------------------------------------------------------
// Results are keyed on data, model and live-weather versions, so a long TTL can never serve stale numbers.
// In-flight promises are cached too: concurrent requests share one Monte-Carlo run.
const cache = new Map();
const TTL = 6 * 3600e3;
const cacheGet = (key) => { const h = cache.get(key); return h && Date.now() - h.at < TTL ? h.value : null; };
const cacheSet = (key, value) => { cache.set(key, { at: Date.now(), value }); if (cache.size > 300) cache.delete(cache.keys().next().value); return value; };
const memo = (key, fn) => { const hit = cacheGet(key); if (hit) return hit; const p = fn().catch((e) => { cache.delete(key); throw e; }); cacheSet(key, p); return p; };
export const dataVersion = () => `${get('SELECT MAX(date) d FROM daily_ops').d}|${loadProductionModel()?.version}`;

export async function runInPool(task, live) {
  const { getPool } = await import('../lib/pool.mjs');
  return getPool().run({ ...task, live: live?.data ? { data: live.data, fetched_at: live.fetched_at } : null, modelVersion: loadProductionModel()?.version });
}

export async function forecast(mineId, scenario = {}, opts = {}) {
  const live = await liveForecast();
  const o = { sims: 240, ...opts };
  const key = JSON.stringify(['m', mineId, scenario, o, dataVersion(), live?.fetched_at]);
  return memo(key, async () => (await runInPool({ task: 'mine', mineId, scenario, opts: o }, live)).summary);
}

/** Portfolio: every mine in parallel, then per-path sums (paths share the sampled weather year). */
export async function portfolioForecast({ sims = 240 } = {}) {
  const live = await liveForecast();
  const key = JSON.stringify(['p', sims, dataVersion(), live?.fetched_at]);
  return memo(key, () => computePortfolio(sims, live));
}

async function computePortfolio(sims, live) {
  const results = await Promise.all(MINES.map((m) => runInPool({ task: 'mine', mineId: m.id, scenario: {}, opts: { sims, returnPaths: true } }, live)));
  const mines = {};
  results.forEach((r, i) => {
    mines[MINES[i].id] = r.summary;
    cacheSet(JSON.stringify(['m', MINES[i].id, {}, { sims }, dataVersion(), live?.fetched_at]), Promise.resolve(r.summary));
  });
  const H = Math.min(...results.map((r) => r.raw.weekPlan.length));
  const days = results[0].raw.days;
  const weekPlan = Array.from({ length: H }, (_, w) => results.reduce((s, r) => s + r.raw.weekPlan[w], 0));
  const prod = Array.from({ length: H }, (_, w) => { const a = new Float64Array(sims); results.forEach((r) => { const x = r.raw.prod[w]; for (let s = 0; s < sims; s++) a[s] += x[s]; }); return a; });
  const f0 = results[0].raw.fy;
  const fy = { label: f0.label, weeks: Math.min(H, f0.weeks), plan: results.reduce((s, r) => s + r.raw.fy.plan, 0),
    fytd_plan: results.reduce((s, r) => s + r.raw.fy.fytd_plan, 0), fytd_actual: results.reduce((s, r) => s + r.raw.fy.fytd_actual, 0) };
  const portfolio = { as_of: results[0].summary.as_of, start: results[0].summary.start, sims, horizon_weeks: H, weather_source: results[0].summary.weather_source,
    ...distSummary({ days, weekPlan, prod, sims, H, fy }) };
  return { portfolio, mines };
}

export const clearForecastCache = () => { cache.clear(); ctxCache.clear(); };

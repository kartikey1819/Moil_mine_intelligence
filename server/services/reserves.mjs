/* Resource & reserve estimation from the drilling database (longitudinal-section kriging).
 *
 *  1. intercepts   along every hole, find the ore run (Mn ≥ 15 %) where it crosses each interpreted lode
 *                  plane → apparent length, true thickness (× |cos| between hole and plane normal), grade.
 *                  Holes that cross a lode without ore give a zero-thickness (barren) pierce point.
 *  2. variography  experimental semivariograms of thickness and accumulation (thickness × grade) in the
 *                  plane of the lode; spherical models fitted by weighted least squares.
 *  3. kriging      ordinary kriging of thickness and accumulation on 25 m × 25 m panels; grade = acc / thickness.
 *  4. classification  Measured / Indicated / Inferred by drill spacing (mean distance to the 3 nearest pierce
 *                  points) → UNFC: 111 proved & 122 probable reserves inside the approved mining depth,
 *                  331 / 332 / 333 resources beyond it or at inferred confidence; mined-out panels depleted.
 */
import { all, get } from '../lib/db.mjs';
import { MINE_BY_ID, ECONOMICS } from '../config/mines.mjs';
import { orebodyFrame, vec } from '../geology/orebody.mjs';
import { loadDem, demSampler, toLatLng } from './terrain.mjs';

const PANEL = 25;
const MIN_WIDTH_M = 1.5;
const round = (v, d = 0) => +(+v).toFixed(d);

function holeDir(h) {
  const az = (h.azimuth * Math.PI) / 180, inc = (-h.dip * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(inc), Math.cos(az) * Math.cos(inc), -Math.sin(inc)];
}

export function intercepts(mine, frame, holes, ivByHole) {
  const pts = [];
  for (const h of holes) {
    const C = [h.collar_e, h.collar_n, h.collar_z], w = holeDir(h), ivs = ivByHole.get(h.id) || [];
    for (const lens of frame.lenses) {
      const P0 = vec.add(frame.origin, vec.mul(frame.n, lens.offset));
      const wn = vec.dot(w, frame.n);
      if (Math.abs(wn) < 1e-3) continue;
      const t = -vec.dot(vec.sub(C, P0), frame.n) / wn;
      if (t <= 0 || t >= h.depth_m) continue;
      const X = vec.add(C, vec.mul(w, t)), q = frame.toPlane(lens, X);
      // ore run nearest to the pierce depth, within ±12 m (lodes are ~26 m apart)
      const win = ivs.filter((iv) => iv.to_m > t - 12 && iv.from_m < t + 12 && iv.mn_pct != null);
      let best = null, cur = null;
      for (const iv of win) {
        const len = iv.to_m - iv.from_m;
        if (iv.mn_pct >= ECONOMICS.interceptMnPct) {
          if (!cur) cur = { from: iv.from_m, to: iv.to_m, mnLen: 0, len: 0 };
          cur.to = iv.to_m; cur.mnLen += iv.mn_pct * len; cur.len += len;
        } else if (cur) {
          const d = Math.abs((cur.from + cur.to) / 2 - t);
          if (!best || d < best.d) best = { ...cur, d };
          cur = null;
        }
      }
      if (cur) { const d = Math.abs((cur.from + cur.to) / 2 - t); if (!best || d < best.d) best = { ...cur, d }; }
      const trueT = best ? best.len * Math.abs(wn) : 0;
      const grade = best ? best.mnLen / best.len : null;
      pts.push({ hole_id: h.id, lens: lens.id, u: round(q.u, 1), v: round(q.v, 1), depth_m: round(frame.depthForV(q.v), 0), from_m: best ? round(best.from, 1) : null, to_m: best ? round(best.to, 1) : null,
        app_m: best ? round(best.len, 2) : 0, true_m: round(trueT, 2), grade: grade == null ? null : round(grade, 2), acc: round(trueT * (grade || 0), 2), purpose: h.purpose, year: +h.drilled_on.slice(0, 4),
        x: round(X[0], 1), y: round(X[1], 1), z: round(X[2], 1) });
    }
  }
  return pts;
}

// ---- variography -------------------------------------------------------------------------------
const spherical = (h, { nugget, sill, range }) => (h <= 0 ? 0 : h >= range ? nugget + sill : nugget + sill * (1.5 * (h / range) - 0.5 * (h / range) ** 3));

export function variogram(pts, key, { lag = 40, maxLag = 720 } = {}) {
  const n = Math.ceil(maxLag / lag), bins = Array.from({ length: n }, () => ({ s: 0, n: 0, h: 0 }));
  const z = pts.map((p) => p[key]);
  const mean = z.reduce((s, v) => s + v, 0) / z.length, variance = z.reduce((s, v) => s + (v - mean) ** 2, 0) / z.length || 1;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const h = Math.hypot(pts[i].u - pts[j].u, pts[i].v - pts[j].v);
    if (h >= maxLag) continue;
    const b = bins[Math.floor(h / lag)]; b.s += 0.5 * (z[i] - z[j]) ** 2; b.n++; b.h += h;
  }
  const exp = bins.filter((b) => b.n >= 6).map((b) => ({ h: round(b.h / b.n, 1), gamma: round(b.s / b.n, 4), pairs: b.n }));
  let best = { nugget: 0, sill: variance, range: 250, sse: Infinity };
  for (let range = 60; range <= 900; range += 20) for (let nf = 0; nf <= 0.6; nf += 0.05) {
    for (const sf of [0.8, 0.9, 1, 1.1, 1.2]) {
      const m = { nugget: nf * variance, sill: (1 - nf) * variance * sf, range };
      const sse = exp.reduce((s, e) => s + (e.pairs / Math.max(e.h, lag)) * (e.gamma - spherical(e.h, m)) ** 2, 0);
      if (sse < best.sse) best = { ...m, sse };
    }
  }
  return { key, variance: round(variance, 4), experimental: exp, model: { type: 'spherical', nugget: round(best.nugget, 4), sill: round(best.sill, 4), range: best.range } };
}

// ---- ordinary kriging --------------------------------------------------------------------------
function solve(A, b) {                       // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

function krige(near, target, key, vm) {
  const n = near.length, cov = (h) => vm.nugget + vm.sill - spherical(h, vm);
  const A = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0)), b = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = cov(Math.hypot(near[i].u - near[j].u, near[i].v - near[j].v));
    A[i][n] = A[n][i] = 1;
    b[i] = cov(Math.hypot(near[i].u - target.u, near[i].v - target.v));
  }
  b[n] = 1;
  const x = solve(A, b);
  if (!x) return null;
  let est = 0, kv = vm.nugget + vm.sill - x[n];
  for (let i = 0; i < n; i++) { est += x[i] * near[i][key]; kv -= x[i] * b[i]; }
  return { est, kv: Math.max(0, kv) };
}

const UNFC = {
  111: { code: '111', label: 'Proved Mineral Reserve', kind: 'Reserve' },
  122: { code: '122', label: 'Probable Mineral Reserve', kind: 'Reserve' },
  331: { code: '331', label: 'Measured Mineral Resource', kind: 'Resource' },
  332: { code: '332', label: 'Indicated Mineral Resource', kind: 'Resource' },
  333: { code: '333', label: 'Inferred Mineral Resource', kind: 'Resource' },
};

const cache = new Map();
export function estimateResources(mineId) {
  const last = get('SELECT MAX(date) d FROM daily_ops WHERE mine_id = ?', mineId)?.d;
  const key = `${mineId}|${last}`;
  if (cache.has(key)) return cache.get(key);
  const mine = MINE_BY_ID[mineId];
  const dem = loadDem(mineId), z = demSampler(dem);
  const frame = orebodyFrame(mine, z(mine.subcropOffsetM[0], mine.subcropOffsetM[1]));
  const holes = all('SELECT * FROM boreholes WHERE mine_id = ? ORDER BY id', mineId);
  const ivs = all('SELECT i.* FROM borehole_intervals i JOIN boreholes b ON b.id = i.hole_id WHERE b.mine_id = ? ORDER BY i.hole_id, i.from_m', mineId);
  const ivByHole = new Map();
  ivs.forEach((iv) => { if (!ivByHole.has(iv.hole_id)) ivByHole.set(iv.hole_id, []); ivByHole.get(iv.hole_id).push(iv); });
  const pierce = intercepts(mine, frame, holes, ivByHole);

  const lenses = frame.lenses.map((L) => {
    const pts = pierce.filter((p) => p.lens === L.id);
    return { ...L, pts, vgT: pts.length >= 8 ? variogram(pts, 'true_m') : null, vgA: pts.length >= 8 ? variogram(pts, 'acc') : null };
  });
  const vgFallback = lenses[0];

  const minedV = frame.vForDepth(mine.ore.minedToM), planV = frame.vForDepth(mine.ore.planDepthM), halfL = mine.ore.strikeLenM / 2;
  const panels = [];
  for (const L of lenses) {
    if (L.pts.length < 3) continue;
    const vgT = (L.vgT || vgFallback.vgT).model, vgA = (L.vgA || vgFallback.vgA).model;
    const uMin = Math.min(...L.pts.map((p) => p.u)) - 60, uMax = Math.max(...L.pts.map((p) => p.u)) + 60, vMax = Math.max(...L.pts.map((p) => p.v)) + 150;
    const radius = Math.min(480, Math.max(vgT.range * 1.6, 200));
    for (let u = Math.floor(uMin / PANEL) * PANEL + PANEL / 2; u < uMax; u += PANEL) {
      for (let v = PANEL / 2; v < vMax; v += PANEL) {
        // 12 nearest pierce points (partial insertion sort — no full sort per panel)
        const nn = [];
        for (const p of L.pts) {
          const h = Math.hypot(p.u - u, p.v - v);
          if (nn.length < 12) { nn.push({ p, h }); nn.sort((a, b) => a.h - b.h); }
          else if (h < nn[11].h) { nn[11] = { p, h }; for (let i = 11; i > 0 && nn[i].h < nn[i - 1].h; i--) [nn[i], nn[i - 1]] = [nn[i - 1], nn[i]]; }
        }
        if (nn.length < 3) continue;
        const d3 = (nn[0].h + nn[1].h + nn[2].h) / 3;
        const near = nn.filter((x) => x.h <= radius).map((x) => x.p);
        if (near.length < 3) continue;
        if (d3 > 250) continue;
        const kt = krige(near, { u, v }, 'true_m', vgT), ka = krige(near, { u, v }, 'acc', vgA);
        if (!kt || !ka) continue;
        const T = Math.max(0, kt.est), A = Math.max(0, ka.est);
        const grade = T > 0.3 ? Math.min(52, A / T) : 0;
        const confidence = d3 <= 60 ? 'Measured' : d3 <= 125 ? 'Indicated' : 'Inferred';
        const depth = frame.depthForV(v);
        const mined = v < minedV && (mine.method === 'UG' || Math.abs(u) < halfL * 0.45);
        const inPlan = v <= planV;
        const mineable = T >= MIN_WIDTH_M && grade >= ECONOMICS.cutoffMnPct;
        let unfc = null;
        if (mined) unfc = 'Depleted';
        else if (!mineable) unfc = 'Below cut-off';
        else if (confidence === 'Inferred') unfc = '333';
        else if (inPlan) unfc = confidence === 'Measured' ? '111' : '122';
        else unfc = confidence === 'Measured' ? '331' : '332';
        const tonnes = PANEL * PANEL * T * ECONOMICS.densityTperM3;
        panels.push({ lens: L.id, u, v, depth: round(depth), T: round(T, 2), grade: round(grade, 2), kv: round(kt.kv / (vgT.nugget + vgT.sill || 1), 3), d3: round(d3), confidence, unfc, tonnes: round(tonnes) });
      }
    }
  }

  // --- summaries -------------------------------------------------------------------------------
  const sumBy = (filter) => { const ps = panels.filter(filter), t = ps.reduce((s, p) => s + p.tonnes, 0); return { tonnes: round(t), grade: t ? round(ps.reduce((s, p) => s + p.tonnes * p.grade, 0) / t, 2) : null, panels: ps.length }; };
  const classes = Object.values(UNFC).map((c) => ({ ...c, ...sumBy((p) => p.unfc === c.code) }));
  // depletion of the proved reserve by production since the estimate's reference date (history start)
  const producedSince = get("SELECT SUM(actual_t) t FROM daily_ops WHERE mine_id = ?", mineId).t || 0;
  const c111 = classes.find((c) => c.code === '111');
  c111.tonnes_before_depletion = c111.tonnes; c111.tonnes = round(Math.max(0, c111.tonnes - producedSince));
  const reserves = classes.filter((c) => c.kind === 'Reserve'), resources = classes.filter((c) => c.kind === 'Resource');
  const tot = (arr) => { const t = arr.reduce((s, c) => s + c.tonnes, 0); return { tonnes: round(t), grade: t ? round(arr.reduce((s, c) => s + c.tonnes * (c.grade || 0), 0) / t, 2) : null }; };
  const reserveTot = tot(reserves), resourceTot = tot(resources);
  const gradeTonnage = [];
  for (let co = 10; co <= 46; co += 2) {
    const ps = panels.filter((p) => p.unfc !== 'Depleted' && p.T >= MIN_WIDTH_M && p.grade >= co), t = ps.reduce((s, p) => s + p.tonnes, 0);
    gradeTonnage.push({ cutoff: co, tonnes: round(t), grade: t ? round(ps.reduce((s, p) => s + p.tonnes * p.grade, 0) / t, 2) : null });
  }

  // --- proposed infill drilling: convert the best Inferred ground inside/near the plan limit ---------
  const infer = panels.filter((p) => p.unfc === '333' && p.v <= planV + 200).sort((a, b) => b.tonnes * b.grade - a.tonnes * a.grade);
  const proposals = [];
  for (const p of infer) {
    if (proposals.length >= 6) break;
    if (proposals.some((q) => Math.hypot(q.u - p.u, q.v - p.v) < 110)) continue;
    const T = frame.point(p.lens, p.u, p.v);
    const az = (frame.dipDirAz + 180) % 360, inc = 62;
    const w = [Math.sin(az * Math.PI / 180) * Math.cos(inc * Math.PI / 180), Math.cos(az * Math.PI / 180) * Math.cos(inc * Math.PI / 180), -Math.sin(inc * Math.PI / 180)];
    let Lh = (z(T[0], T[1]) - T[2]) / -w[2];
    for (let i = 0; i < 5; i++) { const C = vec.sub(T, vec.mul(w, Lh)); Lh = (z(C[0], C[1]) - T[2]) / -w[2]; }
    const C = vec.sub(T, vec.mul(w, Lh)), ll = toLatLng(mine, C[0], C[1]);
    const nearby = panels.filter((q) => q.unfc === '333' && Math.hypot(q.u - p.u, q.v - p.v) <= 75);
    proposals.push({ id: `PROP-${mineId.slice(0, 3).toUpperCase()}-${String(proposals.length + 1).padStart(2, '0')}`, lens: p.lens, u: p.u, v: p.v, target_depth_m: p.depth,
      collar: { e: round(C[0], 1), n: round(C[1], 1), z: round(C[2], 1), lat: round(ll.lat, 6), lng: round(ll.lng, 6) }, azimuth: round(az, 1), dip: -inc, length_m: Math.ceil(Lh + 40),
      est_grade: p.grade, est_thickness: p.T, upgrade_tonnes: round(nearby.reduce((s, q) => s + q.tonnes, 0)), cost_lakh: round((Lh + 40) * 0.09, 1) });
  }

  const result = {
    mine_id: mineId, mine: mine.name, method: mine.method, as_of: last, density: ECONOMICS.densityTperM3, cutoff_mn: ECONOMICS.cutoffMnPct, min_width_m: MIN_WIDTH_M, panel_m: PANEL,
    frame: { origin: frame.origin, s: frame.s, dd: frame.dd, n: frame.n, strikeAz: frame.strikeAz, dipDeg: frame.dipDeg, dipDirAz: frame.dipDirAz, lenses: frame.lenses.map(({ id, name, offset }) => ({ id, name, offset })),
      mined_to_m: mine.ore.minedToM, plan_depth_m: mine.ore.planDepthM, mined_v: round(minedV), plan_v: round(planV), strike_len_m: mine.ore.strikeLenM },
    summary: { reserves: reserveTot, resources: resourceTot, total: tot([...reserves, ...resources]), classes, depleted_since_ref_t: round(producedSince),
      mine_life_years: round(reserveTot.tonnes / mine.annualPlanT, 1), contained_mn_t: round((reserveTot.tonnes * (reserveTot.grade || 0) + resourceTot.tonnes * (resourceTot.grade || 0)) / 100),
      holes: holes.length, metres: round(holes.reduce((s, h) => s + h.depth_m, 0)), intercepts: pierce.filter((p) => p.true_m > 0).length, barren: pierce.filter((p) => p.true_m === 0).length },
    variograms: lenses.filter((L) => L.vgT).map((L) => ({ lens: L.id, thickness: L.vgT, accumulation: L.vgA })),
    pierce, panels, grade_tonnage: gradeTonnage, proposals,
    method_note: 'Ordinary kriging of true thickness and accumulation (thickness × grade) on 25 m panels in the plane of each lode; spherical variograms fitted by weighted least squares; classification by mean distance to the 3 nearest drill intercepts (≤60 m Measured, ≤125 m Indicated, ≤250 m Inferred). Reserve = inside the approved mining depth, ≥25 % Mn, ≥1.5 m true width. AI-assisted, uncertified (not a competent-person statement).',
  };
  for (const k of cache.keys()) if (k.startsWith(`${mineId}|`)) cache.delete(k);
  cache.set(key, result);
  return result;
}

// ---- main-thread access: kriging runs in the worker pool, results cached per mine and day ----------
const asyncCache = new Map();
export async function resources(mineId) {
  const last = get('SELECT MAX(date) d FROM daily_ops WHERE mine_id = ?', mineId)?.d;
  const key = `${mineId}|${last}`;
  if (!asyncCache.has(key)) {
    const { getPool } = await import('../lib/pool.mjs');
    for (const k of asyncCache.keys()) if (k.startsWith(`${mineId}|`)) asyncCache.delete(k);
    asyncCache.set(key, getPool().run({ task: 'reserves', mineId }).catch((e) => { asyncCache.delete(key); throw e; }));
  }
  return asyncCache.get(key);
}

/** Everything the 3D viewer and section plots need. */
export async function reserveScene(mineId) {
  const r = await resources(mineId);
  const holes = all('SELECT id, collar_e, collar_n, collar_z, azimuth, dip, depth_m, purpose, drilled_on FROM boreholes WHERE mine_id = ?', mineId);
  const ivs = all(`SELECT i.hole_id, i.from_m, i.to_m, i.mn_pct, i.lith FROM borehole_intervals i JOIN boreholes b ON b.id = i.hole_id WHERE b.mine_id = ? AND i.mn_pct IS NOT NULL ORDER BY i.hole_id, i.from_m`, mineId);
  const byHole = {};
  ivs.forEach((iv) => { (byHole[iv.hole_id] ||= []).push([iv.from_m, iv.to_m, iv.mn_pct]); });
  return { ...r, holes: holes.map((h) => ({ ...h, dir: holeDir(h), assays: byHole[h.id] || [] })), dem: loadDem(mineId) };
}

export async function boreholeLog(holeId) {
  const hole = get('SELECT * FROM boreholes WHERE id = ?', holeId);
  if (!hole) return null;
  const intervals = all('SELECT from_m, to_m, lith, mn_pct, fe_pct, sio2_pct, p_pct FROM borehole_intervals WHERE hole_id = ? ORDER BY from_m', holeId);
  const r = await resources(hole.mine_id);
  return { hole, intervals, intercepts: r.pierce.filter((p) => p.hole_id === holeId) };
}

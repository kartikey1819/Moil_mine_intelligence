/* Simulated drilling campaign: surface diamond-drill holes collared on the real DEM, surveyed
 * (azimuth / inclination), logged for lithology and assayed (Mn, Fe, SiO2, P) through the ore zone.
 * Output rows match what a MOIL drilling database (collar + survey + assay tables) would export. */
import { Rng, hashSeed } from '../lib/rng.mjs';
import { orebodyFrame, orebodyTruth, vec, WEATHERED_CAP_M } from '../geology/orebody.mjs';
import { toLatLng } from '../services/terrain.mjs';

const PREFIX = { balaghat: 'BLG', ukwa: 'UKW', tirodi: 'TRD', dongri: 'DGB', chikla: 'CHK', kandri: 'KDR', munsar: 'MNS', gumgaon: 'GMG' };
export const minePrefix = (id) => PREFIX[id] || id.slice(0, 3).toUpperCase();
const r = (v, d = 2) => +v.toFixed(d);

export function generateDrilling(mine, dem) {
  const rng = new Rng(hashSeed('drill', mine.id));
  const frame = orebodyFrame(mine, dem(mine.subcropOffsetM[0], mine.subcropOffsetM[1]));
  const truth = orebodyTruth(mine, frame);
  const o = mine.ore, half = o.strikeLenM / 2;
  const vM = frame.vForDepth(o.minedToM), vP = frame.vForDepth(o.planDepthM);

  const targets = [];
  const add = (u, v, era, purpose, incl) => { if (v > 5 && v < o.dipExtentM + 60 && Math.abs(u) < half - 20) targets.push({ u: u + rng.normal(0, 6), v: v + rng.normal(0, 10), era, purpose, incl }); };
  for (let u = -half + 100; u <= half - 100; u += 200) for (const v of [vM * 0.3, vM * 0.75]) add(u, v, [1976, 2004], 'Historical exploration', 55);
  for (let u = -half * 0.62; u <= half * 0.62; u += 50) for (const v of [vM + 25, vM + 75]) add(u, v, [2016, 2025], 'Development infill', 60);
  for (let u = -half + 60; u <= half - 60; u += 100) for (let v = vM + 140; v <= vP; v += 80) add(u, v, [2009, 2024], 'Resource definition', 62);
  for (let u = -half + 120; u <= half - 120; u += 250) for (const v of [vP + 90, vP + 210]) add(u, v, [2019, 2026], 'Deep exploration', 72);

  const holes = [], intervals = [];
  const hwAz = (frame.dipDirAz + 180) % 360;            // collared on the hanging wall, drilled back towards the subcrop
  targets.forEach((t, k) => {
    const id = `${minePrefix(mine.id)}-DH-${String(k + 1).padStart(3, '0')}`;
    const az = (hwAz + rng.normal(0, 4) + 360) % 360, inc = t.incl + rng.normal(0, 2);
    const w = [Math.sin(az * Math.PI / 180) * Math.cos(inc * Math.PI / 180), Math.cos(az * Math.PI / 180) * Math.cos(inc * Math.PI / 180), -Math.sin(inc * Math.PI / 180)];
    const T = frame.point('A', t.u, t.v);
    let L = (dem(T[0], T[1]) - T[2]) / -w[2];
    for (let it = 0; it < 5; it++) { const C = vec.sub(T, vec.mul(w, L)); L = (dem(C[0], C[1]) - T[2]) / -w[2]; }
    const C = vec.sub(T, vec.mul(w, L));
    const depth = Math.ceil(L + (frame.lenses.length > 1 ? 70 : 35) + rng.uniform(0, 15));
    const year = rng.int(t.era[0], t.era[1]);
    const ll = toLatLng(mine, C[0], C[1]);
    holes.push({ id, mine_id: mine.id, collar_e: r(C[0], 1), collar_n: r(C[1], 1), collar_z: r(C[2], 1), lat: r(ll.lat, 6), lng: r(ll.lng, 6),
      azimuth: r(az, 1), dip: r(-inc, 1), depth_m: depth, drilled_on: `${year}-${String(rng.int(1, 12)).padStart(2, '0')}-15`, purpose: t.purpose });

    // log + assay down the hole
    let x = 0;
    while (x < depth) {
      const P = vec.add(C, vec.mul(w, x + 0.5));
      const vDepth = C[2] - P[2];
      let best = null;
      for (const lens of frame.lenses) {
        const q = frame.toPlane(lens, P), th = truth.thickness(lens.id, q.u, q.v);
        const cand = { lens, q, th, d: Math.abs(q.w) };
        if (!best || cand.d < best.d) best = cand;
      }
      const inOre = best.th > 0 && best.d <= best.th / 2;
      const nearOre = best.d < (best.th / 2) + 12;
      const sampled = best.d < 40 && vDepth > WEATHERED_CAP_M;
      const step = inOre || nearOre ? 1 : sampled ? 3 : 10;
      const to = Math.min(depth, x + step);
      let lith, mn = null, fe = null, si = null, p = null;
      if (vDepth <= WEATHERED_CAP_M) { lith = 'Soil / lateritic cap'; }
      else if (inOre) {
        lith = 'Mn ore (braunite–pyrolusite)';
        mn = truth.grade(best.lens.id, best.q.u, best.q.v) + rng.normal(0, 1.8);
      } else if (best.d < best.th / 2 + 3.5) { lith = 'Gondite (Mn-silicate halo)'; mn = rng.uniform(9, 16); }
      else if (best.q.w > 0) { lith = 'Mica schist (hanging wall)'; mn = rng.uniform(0.8, 4); }
      else { lith = 'Quartzite / gondite (footwall)'; mn = rng.uniform(2, 7); }
      if (mn != null && sampled) {
        mn = Math.min(54, Math.max(0.3, mn));
        fe = Math.max(1, 4 + (50 - mn) * 0.22 + rng.normal(0, 1));
        si = Math.max(2, 5 + (52 - mn) * 0.55 + rng.normal(0, 1.8));
        p = Math.max(0.02, 0.07 + (best.lens.id === 'B' ? 0.05 : 0) + rng.normal(0, 0.025));
      } else { mn = fe = si = p = null; }
      intervals.push({ hole_id: id, from_m: r(x, 1), to_m: r(to, 1), lith, mn_pct: mn == null ? null : r(mn), fe_pct: fe == null ? null : r(fe), sio2_pct: si == null ? null : r(si), p_pct: p == null ? null : r(p, 3) });
      x = to;
    }
  });
  // merge consecutive un-assayed intervals of the same lithology
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && last.hole_id === iv.hole_id && last.lith === iv.lith && last.mn_pct == null && iv.mn_pct == null) last.to_m = iv.to_m;
    else merged.push({ ...iv });
  }
  return { holes, intervals: merged, frame };
}

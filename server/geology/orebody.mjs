/* Geological model of a Sausar-type manganese ore body: one or more tabular lenses striking ENE and
 * dipping steeply, with spatially correlated thickness and grade (supergene-enriched near surface).
 *
 * The generator uses it as "ground truth" to simulate drilling. The reserve estimator never reads the
 * truth fields — it only uses the interpreted plane (strike / dip / position), exactly as a geologist's
 * wireframe, and estimates thickness and grade from drill intercepts by kriging.
 */
import { Rng, smoothField, hashSeed } from '../lib/rng.mjs';

const D2R = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const vec = { sub, add, mul, dot, cross, norm };

export const WEATHERED_CAP_M = 12;

/** Interpreted ore-body geometry (what a mine geologist's wireframe would hold). */
export function orebodyFrame(mine, surfaceZ) {
  const o = mine.ore, az = o.strikeAz * D2R, dipDir = az + Math.PI / 2, dip = o.dip * D2R;
  const s = [Math.sin(az), Math.cos(az), 0];
  const dd = [Math.sin(dipDir) * Math.cos(dip), Math.cos(dipDir) * Math.cos(dip), -Math.sin(dip)];
  let n = norm(cross(s, dd)); if (n[2] < 0) n = mul(n, -1);            // normal towards hanging wall (up)
  const [oe, on] = mine.subcropOffsetM;
  const origin = [oe, on, surfaceZ - WEATHERED_CAP_M];
  const lenses = [{ id: 'A', name: 'Main lode', offset: 0, lenF: 1, thickF: 1, gradeShift: 0, uShift: 0 }];
  if (o.lenses > 1) lenses.push({ id: 'B', name: 'Footwall lode', offset: -26, lenF: 0.62, thickF: 0.55, gradeShift: -3.5, uShift: 0.12 * o.strikeLenM });
  const sinDip = Math.sin(dip);
  return {
    s, dd, n, origin, dipDeg: o.dip, strikeAz: o.strikeAz, dipDirAz: (o.strikeAz + 90) % 360, sinDip,
    strikeLen: o.strikeLenM, dipExtent: o.dipExtentM, lenses,
    /** down-dip distance for a vertical depth below surface */
    vForDepth: (depthM) => Math.max(0, (depthM - WEATHERED_CAP_M) / sinDip),
    depthForV: (v) => WEATHERED_CAP_M + v * sinDip,
    point(lens, u, v, w = 0) { const L = typeof lens === 'string' ? lenses.find((x) => x.id === lens) : lens; return add(add(add(add(origin, mul(n, L.offset)), mul(s, u)), mul(dd, v)), mul(n, w)); },
    toPlane(lens, X) { const L = typeof lens === 'string' ? lenses.find((x) => x.id === lens) : lens; const r = sub(X, add(origin, mul(n, L.offset))); return { u: dot(r, s), v: dot(r, dd), w: dot(r, n) }; },
  };
}

/** Hidden truth fields (generator only). */
export function orebodyTruth(mine, frame) {
  const rng = new Rng(hashSeed('orebody', mine.id));
  const o = mine.ore;
  const fields = Object.fromEntries(frame.lenses.map((L) => [L.id, { T: smoothField(rng, { minWl: 140, maxWl: 650 }), G: smoothField(rng, { minWl: 160, maxWl: 800 }) }]));
  const extent = (L) => ({ half: (o.strikeLenM * L.lenF) / 2, V: o.dipExtentM * (L.id === 'A' ? 1 : 0.7) });
  return {
    thickness(lensId, u, v) {
      const L = frame.lenses.find((x) => x.id === lensId), { half, V } = extent(L), uu = u - L.uShift;
      if (Math.abs(uu) > half || v < 0 || v > V) return 0;
      const taper = smooth((half - Math.abs(uu)) / (0.18 * 2 * half)) * smooth((V - v) / (0.15 * V));
      const t = o.thickM * L.thickF * clamp(1 + 0.5 * fields[lensId].T(uu, v), 0, 2.3) * taper;
      return t < 1.0 ? 0 : t;
    },
    grade(lensId, u, v) {
      const L = frame.lenses.find((x) => x.id === lensId), { half } = extent(L), uu = u - L.uShift;
      const taper = smooth((half - Math.abs(uu)) / (0.18 * 2 * half));
      const supergene = v < 60 ? 3 * (1 - v / 60) : 0;
      return clamp(mine.gradeMn + L.gradeShift + o.gradeSd * fields[lensId].G(uu, v) + supergene - 4 * (1 - taper), 16, 52);
    },
  };
}

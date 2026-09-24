/* Gradient-boosted regression trees (squared loss, second-order / XGBoost-style split gain).
 *
 * Output trees use the node-array format of public/js/ml-runtime.js
 *   f[] split feature (-1 = leaf), t[] threshold (x < t goes left), l[]/r[] children,
 *   m[] child for missing values, v[] leaf value, c[] cover (hessian sum = sample count)
 * so the same runtime evaluates them and explains every prediction with exact TreeSHAP.
 */
import { Rng } from '../lib/rng.mjs';

export function trainGBM(X, y, opts = {}) {
  const { nTrees = 320, maxDepth = 4, lr = 0.05, minChild = 10, lambda = 2, gamma = 0, subsample = 0.8, colsample = 0.85, seed = 7, monotone = null } = opts;
  // monotone[j] = +1 (prediction may only rise with feature j), −1 (only fall), 0 (free) — XGBoost-style constraints
  const mono = monotone || new Array(X[0].length).fill(0);
  const clampW = (w, s) => Math.min(s.hi, Math.max(s.lo, w));
  const n = X.length, d = X[0].length, rng = new Rng(seed);
  const base = y.reduce((s, v) => s + v, 0) / n;
  const pred = new Float64Array(n).fill(base);
  const order = Array.from({ length: d }, (_, j) => Array.from({ length: n }, (_, i) => i).sort((a, b) => X[a][j] - X[b][j]));
  const trees = [];
  const inNode = new Int32Array(n);   // node id per row for the current level (-1 = not sampled)
  const g = new Float64Array(n);

  for (let t = 0; t < nTrees; t++) {
    for (let i = 0; i < n; i++) g[i] = pred[i] - y[i];
    const sampled = new Uint8Array(n);
    for (let i = 0; i < n; i++) sampled[i] = rng.next() < subsample ? 1 : 0;
    const feats = Array.from({ length: d }, (_, j) => j).filter(() => rng.next() < colsample);
    if (!feats.length) feats.push(rng.int(0, d - 1));

    const tree = { f: [], t: [], l: [], r: [], m: [], v: [], c: [] };
    const newNode = () => { tree.f.push(-1); tree.t.push(0); tree.l.push(-1); tree.r.push(-1); tree.m.push(-1); tree.v.push(0); tree.c.push(0); return tree.f.length - 1; };
    const root = newNode();
    for (let i = 0; i < n; i++) inNode[i] = sampled[i] ? root : -1;
    let frontier = [root];
    const stats = new Map([[root, { G: 0, H: 0, lo: -Infinity, hi: Infinity }]]);
    for (let i = 0; i < n; i++) if (sampled[i]) { const s = stats.get(root); s.G += g[i]; s.H += 1; }

    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      // best split per frontier node
      const best = new Map(frontier.map((id) => [id, { gain: 0, f: -1, t: 0, wL: 0, wR: 0 }]));
      for (const j of feats) {
        const acc = new Map(frontier.map((id) => [id, { G: 0, H: 0, last: null }]));
        for (const i of order[j]) {
          const id = inNode[i];
          if (id < 0 || !acc.has(id)) continue;
          const a = acc.get(id), xv = X[i][j];
          if (a.last !== null && xv > a.last && a.H >= minChild) {
            const S = stats.get(id), HR = S.H - a.H;
            if (HR >= minChild) {
              const GR = S.G - a.G;
              const wL = clampW(-a.G / (a.H + lambda), S), wR = clampW(-GR / (HR + lambda), S);
              if (!((mono[j] > 0 && wL > wR) || (mono[j] < 0 && wL < wR))) {
                const gain = (a.G * a.G) / (a.H + lambda) + (GR * GR) / (HR + lambda) - (S.G * S.G) / (S.H + lambda) - gamma;
                const b = best.get(id);
                if (gain > b.gain) { b.gain = gain; b.f = j; b.t = (a.last + xv) / 2; b.wL = wL; b.wR = wR; }
              }
            }
          }
          a.G += g[i]; a.H += 1; a.last = xv;
        }
      }
      const next = [];
      for (const id of frontier) {
        const b = best.get(id);
        if (b.f < 0 || b.gain <= 1e-9) continue;
        const L = newNode(), R = newNode();
        tree.f[id] = b.f; tree.t[id] = b.t; tree.l[id] = L; tree.r[id] = R; tree.m[id] = L;
        const P = stats.get(id), mid = (b.wL + b.wR) / 2;
        const bl = { lo: P.lo, hi: P.hi }, br = { lo: P.lo, hi: P.hi };
        if (mono[b.f] > 0) { bl.hi = Math.min(P.hi, mid); br.lo = Math.max(P.lo, mid); }
        if (mono[b.f] < 0) { bl.lo = Math.max(P.lo, mid); br.hi = Math.min(P.hi, mid); }
        stats.set(L, { G: 0, H: 0, ...bl }); stats.set(R, { G: 0, H: 0, ...br });
        next.push(L, R);
      }
      if (!next.length) break;
      for (let i = 0; i < n; i++) {
        const id = inNode[i];
        if (id < 0 || tree.f[id] < 0) continue;
        const child = X[i][tree.f[id]] < tree.t[id] ? tree.l[id] : tree.r[id];
        inNode[i] = child; const s = stats.get(child); s.G += g[i]; s.H += 1;
      }
      frontier = next;
    }
    // leaves + covers
    for (const [id, s] of stats) {
      tree.c[id] = s.H;
      if (tree.f[id] < 0) tree.v[id] = s.H > 0 ? clampW(-s.G / (s.H + lambda), s) * lr : 0;
    }
    // internal covers = sum of children (keeps TreeSHAP consistent)
    for (let id = tree.f.length - 1; id >= 0; id--) if (tree.f[id] >= 0) tree.c[id] = tree.c[tree.l[id]] + tree.c[tree.r[id]];
    trees.push(tree);
    for (let i = 0; i < n; i++) pred[i] += evalTree(tree, X[i]);
  }
  const expected = trees.reduce((s, tr) => s + treeExpectation(tr), base);
  return { base_margin: base, expected_margin: expected, trees, params: { nTrees, maxDepth, lr, minChild, lambda, subsample, colsample, monotone: mono } };
}

export function evalTree(tr, x) { let j = 0; while (tr.f[j] >= 0) j = x[tr.f[j]] < tr.t[j] ? tr.l[j] : tr.r[j]; return tr.v[j]; }
export const predict = (booster, x) => booster.trees.reduce((s, tr) => s + evalTree(tr, x), booster.base_margin);

function treeExpectation(tr) {
  let s = 0; const root = tr.c[0] || 1;
  for (let j = 0; j < tr.f.length; j++) if (tr.f[j] < 0) s += (tr.v[j] * tr.c[j]) / root;
  return s;
}

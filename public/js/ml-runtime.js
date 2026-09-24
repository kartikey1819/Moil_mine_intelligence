/* In-browser runtime for the trained prospectivity model (js/trained-model.js, produced by ml/train.py).
 *
 * No server, no API key: the gradient-boosted trees are evaluated here, and every prediction is
 * explained with exact path-dependent TreeSHAP (Lundberg et al. 2018), verified against XGBoost's
 * own pred_contribs by ml/verify_runtime.js.
 *
 *   TrainedProspectivity.scoreZones(features)  features = live-provider zone Features (one AOI)
 *     -> [{ zone_id, probability, prospectivity_score, base_score, uncertainty, confidence,
 *           evidence: [{ factor, label, value, anomaly, shap_logodds, contribution }], missing: [] }]
 *   base_score + sum(evidence.contribution) === prospectivity_score
 *
 * Tree format: f[] split feature (-1 = leaf), t[] threshold (go left if x < t), l[]/r[] children,
 * m[] child taken when the value is missing, v[] leaf value, c[] cover (training hessian sum).
 */
(function () {
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const isMissing = (v) => v == null || Number.isNaN(v);
  // XGBoost compares float32 values; do the same so browser and Python take identical branches.
  const next = (tr, j, x) => { const v = x[tr.f[j]]; return isMissing(v) ? tr.m[j] : Math.fround(v) < Math.fround(tr.t[j]) ? tr.l[j] : tr.r[j]; };

  function margin(booster, x) {
    let s = booster.base_margin;
    for (const tr of booster.trees) { let j = 0; while (tr.f[j] >= 0) j = next(tr, j, x); s += tr.v[j]; }
    return s;
  }

  // ---- TreeSHAP (path-dependent) -----------------------------------------------------------------
  function extend(path, depth, pz, po, pi) {
    path[depth] = { d: pi, z: pz, o: po, w: depth === 0 ? 1 : 0 };
    for (let i = depth - 1; i >= 0; i--) {
      path[i + 1].w += (po * path[i].w * (i + 1)) / (depth + 1);
      path[i].w = (pz * path[i].w * (depth - i)) / (depth + 1);
    }
  }
  function unwind(path, depth, k) {
    const { o, z } = path[k];
    let nextOne = path[depth].w;
    for (let i = depth - 1; i >= 0; i--) {
      if (o !== 0) {
        const tmp = path[i].w;
        path[i].w = (nextOne * (depth + 1)) / ((i + 1) * o);
        nextOne = tmp - (path[i].w * z * (depth - i)) / (depth + 1);
      } else path[i].w = (path[i].w * (depth + 1)) / (z * (depth - i));
    }
    for (let i = k; i < depth; i++) { path[i].d = path[i + 1].d; path[i].z = path[i + 1].z; path[i].o = path[i + 1].o; }
  }
  function unwoundSum(path, depth, k) {
    const { o, z } = path[k];
    let nextOne = path[depth].w, total = 0;
    for (let i = depth - 1; i >= 0; i--) {
      if (o !== 0) {
        const tmp = (nextOne * (depth + 1)) / ((i + 1) * o);
        total += tmp;
        nextOne = path[i].w - (tmp * z * (depth - i)) / (depth + 1);
      } else total += path[i].w / z / ((depth - i) / (depth + 1));
    }
    return total;
  }
  function treeShap(tr, x, phi) {
    (function recurse(j, parent, depth, pz, po, pi) {
      const path = parent.slice(0, depth).map((e) => ({ ...e }));
      extend(path, depth, pz, po, pi);
      if (tr.f[j] < 0) {
        for (let i = 1; i <= depth; i++) phi[path[i].d] += unwoundSum(path, depth, i) * (path[i].o - path[i].z) * tr.v[j];
        return;
      }
      const hot = next(tr, j, x), cold = hot === tr.l[j] ? tr.r[j] : tr.l[j];
      let iz = 1, io = 1, k = -1;
      for (let i = 1; i <= depth; i++) if (path[i].d === tr.f[j]) { k = i; break; }
      if (k >= 0) { iz = path[k].z; io = path[k].o; unwind(path, depth, k); depth--; }
      recurse(hot, path, depth + 1, (iz * tr.c[hot]) / tr.c[j], io, tr.f[j]);
      recurse(cold, path, depth + 1, (iz * tr.c[cold]) / tr.c[j], 0, tr.f[j]);
    })(0, [], 0, 1, 1, -1);
  }
  /** Exact SHAP values in log-odds space; margin(x) === booster.expected_margin + sum(phi). */
  function shap(booster, x) {
    const phi = new Array(x.length).fill(0);
    booster.trees.forEach((tr) => treeShap(tr, x, phi));
    return phi;
  }

  // ---- feature engineering: must mirror ml/features.py ------------------------------------------
  const median = (a) => { const s = a.filter((v) => !isMissing(v)).sort((p, q) => p - q); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };

  /** transform 'aoi_anomaly' = value minus the AOI median (removes scene date / season / regional offsets). */
  function buildMatrix(model, features) {
    const med = {};
    model.features.filter((f) => f.transform === 'aoi_anomaly').forEach((f) => { med[f.source] = median(features.map((z) => z.properties[f.source])); });
    return features.map((z) => model.features.map((f) => {
      const v = z.properties[f.source];
      if (isMissing(v)) return null;
      return f.transform === 'aoi_anomaly' ? (med[f.source] == null ? null : v - med[f.source]) : v;
    }));
  }

  function scoreZones(features, model = window.TrainedModel) {
    const X = buildMatrix(model, features);
    const baseProb = sigmoid(model.booster.expected_margin);
    return features.map((z, n) => {
      const x = X[n];
      const prob = sigmoid(margin(model.booster, x));
      const phi = shap(model.booster, x);
      const score = +(prob * 100).toFixed(2), base = +(baseProb * 100).toFixed(2);
      // SHAP is additive in log-odds; share the score difference between factors in that proportion.
      const sum = phi.reduce((s, v) => s + v, 0), k = Math.abs(sum) > 1e-9 ? (score - base) / sum : 0;
      const evidence = model.features.map((f, i) => ({
        factor: f.name, label: f.label, value: z.properties[f.source], anomaly: f.transform === 'aoi_anomaly' && x[i] != null ? +x[i].toFixed(3) : null,
        shap_logodds: +phi[i].toFixed(4), contribution: +(phi[i] * k).toFixed(2),
      }));
      // Uncertainty = spread of the bootstrap ensemble (models trained on resampled mines).
      const ps = model.ensemble.map((b) => sigmoid(margin(b, x)));
      const mean = ps.reduce((s, v) => s + v, 0) / ps.length;
      const sd = Math.sqrt(ps.reduce((s, v) => s + (v - mean) ** 2, 0) / ps.length) * 100;
      const missing = model.features.filter((f, i) => x[i] == null).map((f) => f.name);
      return {
        zone_id: z.properties.zone_id, probability: +prob.toFixed(4), prospectivity_score: score, base_score: base,
        uncertainty: +sd.toFixed(1), confidence: missing.length > 2 || sd >= model.confidence_bands.low ? 'Low' : sd >= model.confidence_bands.medium ? 'Medium' : 'High',
        evidence, missing,
      };
    });
  }

  /** What-if: re-score one zone with some raw values overridden (AOI medians stay those of `features`). */
  function whatIf(features, zoneId, overrides, model = window.TrainedModel) {
    const p = { ...features.find((z) => z.properties.zone_id === zoneId).properties, ...overrides };
    const x = model.features.map((f) => {
      const v = p[f.source];
      if (isMissing(v)) return null;
      if (f.transform !== 'aoi_anomaly') return v;
      const med = median(features.map((z) => z.properties[f.source]));
      return med == null ? null : v - med;
    });
    return +(sigmoid(margin(model.booster, x)) * 100).toFixed(2);
  }

  const api = { margin, shap, sigmoid, buildMatrix, scoreZones, whatIf };
  if (typeof window !== 'undefined') { window.MLRuntime = api; window.TrainedProspectivity = { scoreZones, whatIf }; }
  if (typeof module !== 'undefined') module.exports = api;
})();

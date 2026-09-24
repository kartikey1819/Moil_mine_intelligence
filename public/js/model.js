/* Layer 1 prospectivity model — knowledge-driven weighted evidence over live measurements.
 *
 * Spectral / thermal / terrain values are turned into favourability by their percentile rank
 * inside the AOI (anomaly mapping — robust to scene date and illumination). The score is
 * sum(weight x favourability) x 100, so every point is traceable to a factor. Factors whose
 * data source was unavailable are dropped and the remaining weights renormalised.
 * Weights are user-adjustable in the UI; once MOIL drilling outcomes exist they should be
 * replaced by fitted coefficients (logistic / GBM + SHAP) with the same evidence[] output.
 */
(function () {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const pct = (f) => `top ${Math.max(1, Math.round((1 - f) * 100))}% of this AOI`;

  function lithFav(p) {
    const t = `${p.lithology} ${p.lithology_class}`.toLowerCase(), age = (p.geologic_age || '').toLowerCase();
    if (/basalt|volcanic rocks$|deccan|trap/.test(t) && !/sediment/.test(t)) return 0.05;
    if (/alluvi|quaternary|unconsolidated|laterite/.test(t + age)) return 0.15;
    if (/granit|pluton|intrusive/.test(t)) return 0.15;
    if (/proterozoic/.test(age + t) && /sediment|schist|metased|marble|quartzite/.test(t)) return 0.9; // Sausar-type supracrustals
    if (/metamorphic|gneiss|crystalline/.test(t)) return 0.4;
    return 0.3;
  }

  const FACTORS = [
    { key: 'ferric_iron', label: 'Ferric-iron ratio (S2 B4/B2)', weight: 0.22, needs: 'ferric_ratio', rank: (p) => p.ferric_ratio, value: (p) => p.ferric_ratio,
      why: (p, f) => f >= 0.7 ? `has a strong ferric-iron / lateritic-cap response (B4/B2 = ${p.ferric_ratio}, ${pct(f)}) typical above weathered Mn horizons` : f >= 0.4 ? `has a moderate ferric-iron response (B4/B2 = ${p.ferric_ratio})` : `has a weak ferric-iron response (B4/B2 = ${p.ferric_ratio})` },
    { key: 'dark_oxide', label: 'Dark bare surface (low albedo)', weight: 0.18, needs: 'albedo', rank: (p) => -p.albedo, scale: (p) => clamp((0.6 - p.ndvi) / 0.4), value: (p) => `albedo ${p.albedo}`,
      why: (p, f) => f >= 0.6 ? `is dark, sparsely vegetated ground (albedo ${p.albedo}) — Mn oxides are among the darkest surface materials` : p.ndvi > 0.5 ? 'is too vegetated for the surface darkness test to say anything' : `is relatively bright ground (albedo ${p.albedo}), unlike Mn-oxide outcrop` },
    { key: 'lithology', label: 'Mapped lithology', weight: 0.15, needs: 'lithology', fav: lithFav, value: (p) => p.lithology,
      why: (p, f) => f >= 0.8 ? `is mapped as ${p.lithology} — the Proterozoic supracrustal setting that hosts Sausar-belt manganese` : f >= 0.35 ? `is mapped as ${p.lithology}, which can enclose Mn-bearing supracrustal bands` : `is mapped as ${p.lithology}, an unfavourable host for manganese` },
    { key: 'vegetation_stress', label: 'Vegetation stress (low NDVI)', weight: 0.10, needs: 'ndvi', rank: (p) => -p.ndvi, value: (p) => `NDVI ${p.ndvi}`,
      why: (p, f) => f >= 0.65 ? `shows sparse or stressed vegetation (NDVI ${p.ndvi}), a common geobotanical response to Mn-rich soil` : `has healthy vegetation (NDVI ${p.ndvi}) and no geobotanical anomaly` },
    { key: 'thermal_anomaly', label: 'Surface temperature anomaly', weight: 0.10, needs: 'lst_c', rank: (p) => p.lst_c, value: (p) => `${p.lst_c} °C`,
      why: (p, f) => f >= 0.65 ? `is thermally warm (${p.lst_c} °C, ${pct(f)}), as expected for dark oxide-rich ground` : `shows no thermal anomaly (${p.lst_c} °C)` },
    { key: 'ridge_position', label: 'Ridge position (TPI)', weight: 0.10, needs: 'tpi_m', rank: (p) => p.tpi_m, value: (p) => `${p.tpi_m > 0 ? '+' : ''}${p.tpi_m} m`,
      why: (p, f) => f >= 0.65 ? `stands ${p.tpi_m} m above its surroundings — resistant gondite / Mn-ore bands form strike ridges in this belt` : `is low-lying (${p.tpi_m} m vs surroundings), where ore bands are usually buried or absent` },
    { key: 'clay_hydroxyl', label: 'Clay / hydroxyl ratio (S2 B11/B12)', weight: 0.08, needs: 'clay_ratio', rank: (p) => p.clay_ratio, value: (p) => p.clay_ratio,
      why: (p, f) => f >= 0.65 ? `has an elevated clay/hydroxyl response (B11/B12 = ${p.clay_ratio}) indicating deep weathering that drives supergene Mn enrichment` : `shows little clay/hydroxyl weathering signature (B11/B12 = ${p.clay_ratio})` },
    { key: 'known_workings', label: 'Proximity to existing workings', weight: 0.07, needs: 'dist_workings_km', fav: (p) => Math.exp(-p.dist_workings_km / 1.5), value: (p) => `${p.dist_workings_km} km`,
      why: (p, f) => f >= 0.5 ? `is ${p.dist_workings_km} km from an OSM-mapped quarry/mine (strike-extension potential)` : `is ${p.dist_workings_km} km from the nearest mapped working` },
  ];
  const DEFAULT_WEIGHTS = Object.fromEntries(FACTORS.map((f) => [f.key, f.weight]));
  const classify = (s) => (s >= 66 ? 'High' : s >= 50 ? 'Moderate' : 'Low');

  function percentileRanks(values) {
    const idx = values.map((v, i) => [v, i]).filter(([v]) => v != null).sort((a, b) => a[0] - b[0]);
    const out = new Array(values.length).fill(null);
    idx.forEach(([, i], k) => { out[i] = idx.length > 1 ? k / (idx.length - 1) : 0.5; });
    return out;
  }

  /** Scores every zone in place (properties.result). Returns the effective (renormalised) weights. */
  function scoreAll(features, weights = DEFAULT_WEIGHTS) {
    const P = features.map((f) => f.properties);
    const active = FACTORS.filter((f) => weights[f.key] > 0 && P.some((p) => p[f.needs] != null));
    const wsum = active.reduce((s, f) => s + weights[f.key], 0) || 1;
    const eff = Object.fromEntries(active.map((f) => [f.key, +(weights[f.key] / wsum).toFixed(4)]));
    const ranks = Object.fromEntries(active.filter((f) => f.rank).map((f) => [f.key, percentileRanks(P.map((p) => (p[f.needs] == null ? null : f.rank(p))))]));

    P.forEach((p, i) => {
      const water = p.ndwi != null && p.ndwi > 0.1;
      const evidence = active.filter((f) => p[f.needs] != null).map((f) => {
        let fav = f.rank ? ranks[f.key][i] : f.fav(p);
        if (f.scale) fav *= f.scale(p);
        if (water) fav = 0;
        return { factor: f.key, label: f.label, value: f.value(p), favourability: +fav.toFixed(3), weight: eff[f.key], contribution: +(fav * eff[f.key] * 100).toFixed(1), _why: f.why(p, fav), _spectral: !!f.rank && f.needs !== 'tpi_m' };
      });
      const covered = evidence.reduce((s, e) => s + e.weight, 0) || 1;
      const score = +evidence.reduce((s, e) => s + e.contribution, 0).toFixed(1);
      const cls = classify(score);

      const mean = (a) => (a.length ? a.reduce((s, e) => s + e.favourability, 0) / a.length : null);
      const sp = mean(evidence.filter((e) => e._spectral)), ot = mean(evidence.filter((e) => !e._spectral));
      const gap = sp == null || ot == null ? 0.5 : Math.abs(sp - ot);
      const confidence = water ? 'High' : covered < 0.6 || gap >= 0.45 ? 'Low' : covered < 0.95 || gap >= 0.25 ? 'Medium' : 'High';

      const ranked = [...evidence].sort((a, b) => b.contribution - a.contribution);
      const weakest = [...evidence].sort((a, b) => a.favourability - b.favourability)[0];
      let explanation;
      if (water) explanation = `Masked as open water (NDWI ${p.ndwi}) — surface indicators are not meaningful here, score forced to 0.`;
      else if (!evidence.length) explanation = 'No live data source returned values for this zone, so it could not be scored.';
      else {
        explanation = `Prospectivity ${score}/100 (${cls}). This zone ${ranked[0]._why}` + (ranked[1] ? `; it also ${ranked[1]._why}` : '') + '. ' +
          (weakest && weakest !== ranked[0] ? `Main limiting factor: it ${weakest._why}. ` : '') +
          (confidence === 'Low' ? 'Spectral and geological/terrain evidence disagree (or data is incomplete), so confidence is low — ground-truth before drilling. '
            : `Independent evidence groups ${confidence === 'High' ? 'agree well' : 'partly agree'} (confidence ${confidence}). `) +
          (p.dist_workings_km != null && p.dist_workings_km < 0.3 ? 'Note: this zone overlaps an existing working, so part of the surface response is exposed pit/dump material.' : '');
      }
      const recommended_action = water || !evidence.length ? 'Excluded from targeting'
        : cls === 'High' ? 'Prioritise for Layer-2 drilling / borehole correlation'
        : cls === 'Moderate' ? 'Ground geophysics + pitting/trenching before drilling' : 'No follow-up recommended at present';

      evidence.forEach((e) => { delete e._why; delete e._spectral; });
      p.result = { prospectivity_score: score, prospectivity_class: cls, confidence, masked: water ? 'water' : null, evidence, explanation: explanation.trim(), recommended_action };
    });
    return eff;
  }

  window.ProspectivityModel = {
    name: 'MOIL-L1 weighted-evidence prospectivity index',
    version: '2.0.0',
    type: 'knowledge-driven weighted overlay on AOI-relative anomalies (not yet trained on MOIL drilling outcomes)',
    factors: FACTORS.map(({ key, label, weight }) => ({ key, label, weight })),
    DEFAULT_WEIGHTS,
    context_only_inputs: ['rainfall_mm_yr', 'soil_moisture_m3m3', 'slope_deg', 'elevation_m'],
    scoreAll, classify,
  };
})();

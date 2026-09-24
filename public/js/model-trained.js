/* Trained Layer-1 model behind the same interface as js/model.js, so the app can switch with
 *   const model = window.TrainedProspectivityModel;
 * Needs js/trained-model.js and js/ml-runtime.js loaded first.
 *
 * scoreAll(features) fills properties.result in the shape model.js produces. Differences:
 *   - prospectivity_score is P(zone looks like known manganese ground) x 100, from XGBoost
 *   - evidence[].contribution is a signed SHAP share; the first entry is the base rate, so the
 *     contributions still sum to the score (the Layer-2 contract check keeps passing)
 *   - confidence comes from a bootstrap ensemble (result.uncertainty = +/- score points)
 *   - no hand-set weights: `weights` is accepted and ignored; the returned map is global mean |SHAP|
 */
(function () {
  const M = window.TrainedModel, RT = window.TrainedProspectivity;
  const T = M.class_thresholds;
  const classify = (s) => (s >= T.high ? 'High' : s >= T.moderate ? 'Moderate' : 'Low');

  // how each factor reads when it is above / below the AOI's typical value
  const WORDS = {
    ferric_ratio: ['a stronger ferric-iron / oxide response than the surrounding ground', 'a weaker ferric-iron response than its surroundings'],
    clay_ratio: ['an elevated clay / hydroxyl (deep-weathering) response', 'little clay / hydroxyl weathering response'],
    albedo: ['brighter ground than the AOI average', 'darker ground than the AOI average, as Mn oxides are'],
    ndvi: ['denser vegetation than the AOI average', 'sparse or stressed vegetation'],
    ndwi: ['a wetter surface than the AOI average', 'a drier surface than the AOI average'],
    lst_c: ['a warm surface-temperature anomaly', 'a cool surface-temperature anomaly'],
    tpi_m: ['a ridge position above its surroundings', 'a low-lying position'],
    slope_deg: ['steep terrain', 'gentle terrain'],
  };
  const describe = (e) => {
    const ref = e.anomaly != null ? e.anomaly : e.factor === 'slope_deg' ? e.value - 5 : e.value;
    return `${WORDS[e.factor][ref >= 0 ? 0 : 1]} (${e.value}${e.anomaly != null ? `, ${e.anomaly > 0 ? '+' : ''}${e.anomaly} vs AOI median` : ''})`;
  };

  function scoreAll(features) {
    const scored = RT.scoreZones(features, M);
    features.forEach((f, i) => {
      const p = f.properties, r = scored[i];
      const water = p.ndwi != null && p.ndwi > 0.1;
      const noData = r.missing.length === M.features.length;
      const up = r.evidence.filter((e) => e.contribution > 0).sort((a, b) => b.contribution - a.contribution);
      const down = r.evidence.filter((e) => e.contribution < 0).sort((a, b) => a.contribution - b.contribution);
      const score = water || noData ? 0 : +r.prospectivity_score.toFixed(1), cls = classify(score);
      const base = { factor: 'base_rate', label: 'Base rate (average zone in the training belt)', value: `${r.base_score}/100`, shap_logodds: 0, contribution: r.base_score, favourability: null, weight: null };
      const evidence = water || noData ? [] : [base, ...r.evidence.map((e) => ({ ...e, favourability: null, weight: M.weights[e.factor] }))];

      let explanation;
      if (water) explanation = `Masked as open water (NDWI ${p.ndwi}) — surface indicators are not meaningful here, score forced to 0.`;
      else if (noData) explanation = 'No live data source returned values for this zone, so it could not be scored.';
      else {
        explanation = `Prospectivity ${score}/100 (${cls}): the trained model gives this zone a ${score}% resemblance to known Sausar-belt manganese ground, against a base rate of ${r.base_score}%. ` +
          (up.length ? `Pushing the score up: ${up.slice(0, 2).map((e) => `${describe(e)} [+${e.contribution}]`).join('; ')}. ` : '') +
          (down.length ? `Holding it down: ${down.slice(0, 2).map((e) => `${describe(e)} [${e.contribution}]`).join('; ')}. ` : '') +
          `Models retrained on different subsets of mines disagree by ±${r.uncertainty} points (confidence ${r.confidence}). ` +
          (r.missing.length ? `Missing inputs: ${r.missing.join(', ')}. ` : '') +
          (p.dist_workings_km != null && p.dist_workings_km < 0.3 ? 'Note: this zone overlaps an existing working — the model was trained on such ground, so a high score here confirms the model rather than finding something new.' : '');
      }
      const recommended_action = water || noData ? 'Excluded from targeting'
        : cls === 'High' ? (r.confidence === 'Low' ? 'High score but models disagree — field-check before Layer-2 drilling' : 'Prioritise for Layer-2 drilling / borehole correlation')
        : cls === 'Moderate' ? 'Ground geophysics + pitting/trenching before drilling' : 'No follow-up recommended at present';

      p.result = { prospectivity_score: score, prospectivity_class: cls, confidence: r.confidence, uncertainty: r.uncertainty, base_score: r.base_score,
        probability: r.probability, masked: water ? 'water' : null, evidence, explanation: explanation.trim(), recommended_action };
    });
    return { ...M.weights };
  }

  window.TrainedProspectivityModel = {
    name: M.name, version: M.version, type: M.type, trained: true,
    factors: M.features.map((f) => ({ key: f.name, label: f.label, weight: M.weights[f.name] })),
    DEFAULT_WEIGHTS: { ...M.weights },
    context_only_inputs: ['rainfall_mm_yr', 'soil_moisture_m3m3', 'elevation_m', 'lithology', 'dist_workings_km'],
    card: { training: M.training, validation: M.validation, limitations: M.limitations, class_thresholds: T, trained_at: M.trained_at },
    scoreAll, classify, whatIf: (features, zoneId, overrides) => RT.whatIf(features, zoneId, overrides, M),
  };
})();

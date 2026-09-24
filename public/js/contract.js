/* Layer-1 -> Layer-2 contract (moil.layer1.prospectivity v2.0.0).
 * Layer 2 (drilling / borehole / grade / depth / 3D) consumes exactly this document.
 * build() assembles it, validate() checks it, toGeoJSON() is the same content as a FeatureCollection.
 */
(function () {
  const CONTRACT = 'moil.layer1.prospectivity';
  const SCHEMA_VERSION = '2.0.0';
  const ZONE_PROPS = ['lithology', 'lithology_class', 'geologic_age', 'ferric_ratio', 'clay_ratio', 'albedo', 'ndvi', 'ndwi', 'lst_c',
    'elevation_m', 'tpi_m', 'slope_deg', 'dist_workings_km', 'rainfall_mm_yr', 'soil_moisture_m3m3'];

  function build(analysis, model, effectiveWeights) {
    const feats = analysis.zones.features;
    const ranked = [...feats].sort((a, b) => b.properties.result.prospectivity_score - a.properties.result.prospectivity_score);
    const rank = new Map(ranked.map((f, i) => [f.properties.zone_id, i + 1]));
    const zones = feats.map((f) => {
      const p = f.properties, r = p.result;
      return {
        zone_id: p.zone_id, geometry: f.geometry, centroid: p.centroid, area_ha: p.area_ha,
        prospectivity_score: r.prospectivity_score, prospectivity_class: r.prospectivity_class, confidence: r.confidence,
        masked: r.masked, drill_priority_rank: rank.get(p.zone_id), recommended_action: r.recommended_action,
        features: Object.fromEntries(ZONE_PROPS.map((k) => [k, p[k] ?? null])),   // null = source unavailable, never imputed
        evidence: r.evidence, explanation: r.explanation,
      };
    });
    const count = (c) => zones.filter((z) => z.prospectivity_class === c).length;
    return {
      contract: CONTRACT, schema_version: SCHEMA_VERSION, generated_at: new Date().toISOString(), crs: 'EPSG:4326',
      data_provenance: {
        mode: 'LIVE_PUBLIC',
        note: 'All values fetched live from public APIs at generated_at. Public satellite/regional data only — no MOIL proprietary data, no synthetic values. Unavailable sources yield nulls.',
        sources: analysis.sources,
      },
      aoi: analysis.aoi,
      climate_context: analysis.climate,
      model: { name: model.name, version: model.version, type: model.type, weights: effectiveWeights, context_only_inputs: model.context_only_inputs },
      summary: { zone_count: zones.length, high: count('High'), moderate: count('Moderate'), low: count('Low'),
        high_prospectivity_area_ha: +zones.filter((z) => z.prospectivity_class === 'High').reduce((s, z) => s + z.area_ha, 0).toFixed(1) },
      zones,
    };
  }

  function toGeoJSON(doc) {
    const { zones, ...meta } = doc;
    return { type: 'FeatureCollection', ...meta, features: zones.map(({ geometry, ...props }) => ({ type: 'Feature', id: props.zone_id, geometry, properties: props })) };
  }

  function validate(doc) {
    const checks = [];
    const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail ?? '') });
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

    check('contract id', doc.contract === CONTRACT, doc.contract);
    check('schema_version is semver 2.x', /^2\.\d+\.\d+$/.test(doc.schema_version || ''), doc.schema_version);
    check('generated_at is ISO timestamp', !Number.isNaN(Date.parse(doc.generated_at)));
    check('crs is EPSG:4326', doc.crs === 'EPSG:4326');
    check('data_provenance.mode declared', ['LIVE_PUBLIC', 'PRODUCTION'].includes(doc.data_provenance?.mode), doc.data_provenance?.mode);
    const src = doc.data_provenance?.sources || [];
    check('every source reports status (+ timestamp if live)', src.length > 0 && src.every((s) => s.status === 'unavailable' || (s.status === 'live' && !Number.isNaN(Date.parse(s.fetched_at)))), `${src.filter((s) => s.status === 'live').length}/${src.length} live`);
    check('aoi has id, name, lat, lng, bbox', doc.aoi && doc.aoi.id && doc.aoi.name && isNum(doc.aoi.lat) && isNum(doc.aoi.lng) && doc.aoi.bbox?.length === 4);
    const wsum = Object.values(doc.model?.weights || {}).reduce((s, w) => s + w, 0);
    check('effective model weights sum to 1', Math.abs(wsum - 1) < 0.01, wsum.toFixed(3));
    check('zones[] non-empty', Array.isArray(doc.zones) && doc.zones.length > 0, `${doc.zones?.length ?? 0} zones`);

    const zs = doc.zones || [];
    const ids = new Set(zs.map((z) => z.zone_id));
    check('zone_id unique', ids.size === zs.length);
    const all = (name, fn) => { const bad = zs.filter((z) => !fn(z)); check(name, bad.length === 0, bad.length ? `${bad.length} failing, e.g. ${bad[0].zone_id}` : `${zs.length}/${zs.length}`); };
    all('geometry is closed Polygon', (z) => { const r = z.geometry?.coordinates?.[0]; return z.geometry?.type === 'Polygon' && r?.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]; });
    all('prospectivity_score in 0–100', (z) => isNum(z.prospectivity_score) && z.prospectivity_score >= 0 && z.prospectivity_score <= 100);
    all('prospectivity_class in High|Moderate|Low', (z) => ['High', 'Moderate', 'Low'].includes(z.prospectivity_class));
    all('confidence in High|Medium|Low', (z) => ['High', 'Medium', 'Low'].includes(z.confidence));
    all('drill_priority_rank is a positive integer', (z) => Number.isInteger(z.drill_priority_rank) && z.drill_priority_rank >= 1);
    all('evidence contributions sum to score (±0.5)', (z) => Math.abs(z.evidence.reduce((s, e) => s + e.contribution, 0) - z.prospectivity_score) <= 0.5);
    all('all feature keys present (null allowed)', (z) => ZONE_PROPS.every((k) => k in (z.features || {})));
    all('explanation + recommended_action present', (z) => z.explanation?.length > 20 && z.recommended_action?.length > 0);

    return { valid: checks.every((c) => c.ok), checks };
  }

  window.Layer2Contract = { CONTRACT, SCHEMA_VERSION, build, toGeoJSON, validate };
})();

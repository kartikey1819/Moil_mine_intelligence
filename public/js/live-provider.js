/* Layer 1 live data provider — nothing in here is generated or hard-coded.
 * Every value is fetched at analysis time from a public, key-less API:
 *
 *   Sentinel-2 L2A  (Microsoft Planetary Computer)  -> NDVI, ferric-iron ratio, clay ratio, albedo, NDWI
 *   Landsat 8/9 C2 L2 thermal (Planetary Computer)  -> land surface temperature
 *   Copernicus DEM 90 m (Open-Meteo elevation API)  -> elevation, slope, topographic position
 *   Macrostrat geologic map API                     -> mapped lithology / age
 *   ERA5-Land reanalysis (Open-Meteo archive API)   -> rainfall, soil moisture (AOI level, ~10 km grid)
 *   OpenStreetMap Overpass                          -> existing quarries / mine workings
 *
 * analyse(aoi, onStep) returns zones with raw measured values. A source that fails is reported
 * and its factor is simply left out (the model renormalises) — it is never back-filled.
 * A MOIL provider (mine plans, GSI 1:50k geology, assay-calibrated indices) keeps this interface.
 */
(function () {
  const PC = 'https://planetarycomputer.microsoft.com/api';
  const N = 16;            // N x N zones
  const HALF_KM = 2.4;     // AOI half-width  -> 300 m zones
  const SUB = 4;           // raster oversampling per zone (averaged)
  const KM = 111.32;
  const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

  // Bookmarks only (approximate public locations of MOIL mines). Any other place can be searched or clicked.
  const BOOKMARKS = [
    { id: 'balaghat', name: 'Balaghat (Bharveli) Mine, MP', lat: 21.842, lng: 80.235 },
    { id: 'ukwa', name: 'Ukwa Mine, MP', lat: 21.972, lng: 80.468 },
    { id: 'tirodi', name: 'Tirodi Mine, MP', lat: 21.685, lng: 79.72 },
    { id: 'dongri', name: 'Dongri Buzurg Mine, MH', lat: 21.62, lng: 79.755 },
    { id: 'chikla', name: 'Chikla Mine, MH', lat: 21.56, lng: 79.7 },
    { id: 'kandri', name: 'Kandri Mine, MH', lat: 21.42, lng: 79.275 },
    { id: 'munsar', name: 'Munsar Mine, MH', lat: 21.398, lng: 79.3 },
    { id: 'gumgaon', name: 'Gumgaon Mine, MH', lat: 21.37, lng: 78.985 },
  ];

  async function getJSON(url, opts = {}, timeoutMs = 45000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  function bboxOf(aoi) {
    const dLat = HALF_KM / KM, dLng = HALF_KM / (KM * Math.cos((aoi.lat * Math.PI) / 180));
    return [aoi.lng - dLng, aoi.lat - dLat, aoi.lng + dLng, aoi.lat + dLat];
  }

  // ---- satellite rasters -------------------------------------------------------------------
  async function searchScenes(collection, bbox, filter) {
    const q = new URLSearchParams({ collections: collection, bbox: bbox.join(','), limit: '6', sortby: '-datetime', 'filter-lang': 'cql2-text', filter });
    const fc = await getJSON(`${PC}/stac/v1/search?${q}`);
    return fc.features.map((f) => ({ id: f.id, datetime: f.properties.datetime, cloud: f.properties['eo:cloud_cover'], platform: f.properties.platform }));
  }

  /** Fetch one band-math raster for the AOI as an N*N array of zone means (row 0 = north). */
  async function rasterGrid(collection, item, assets, expression, lo, hi, bbox) {
    const q = new URLSearchParams({ collection, item, expression, rescale: `${lo},${hi}`, asset_as_band: 'false' });
    assets.forEach((a) => q.append('assets', a));
    const size = N * SUB;
    const r = await fetch(`${PC}/data/v1/item/bbox/${bbox.join(',')}/${size}x${size}.png?${q}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bmp = await createImageBitmap(await r.blob());
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    const out = new Array(N * N).fill(null);
    for (let r0 = 0; r0 < N; r0++) for (let c0 = 0; c0 < N; c0++) {
      let s = 0, n = 0;
      for (let y = 0; y < SUB; y++) for (let x = 0; x < SUB; x++) {
        const i = ((r0 * SUB + y) * size + c0 * SUB + x) * 4;
        if (px[i + 3] > 0) { s += px[i]; n++; }   // alpha 0 = nodata
      }
      if (n >= (SUB * SUB) / 2) out[r0 * N + c0] = lo + (s / n / 255) * (hi - lo);
    }
    return out;
  }
  const validFrac = (g) => g.filter((v) => v != null).length / g.length;

  // Sentinel-2 L2A reflectance = (DN - 1000) / 10000 for processing baseline >= 04.00
  const b = (n) => `(${n}_b1-1000)`;
  const S2 = {
    ndvi: { assets: ['B08', 'B04'], expr: `(${b('B08')}-${b('B04')})/(${b('B08')}+${b('B04')})`, lo: -1, hi: 1 },
    ndwi: { assets: ['B03', 'B08'], expr: `(${b('B03')}-${b('B08')})/(${b('B03')}+${b('B08')})`, lo: -1, hi: 1 },
    ferric_ratio: { assets: ['B04', 'B02'], expr: `${b('B04')}/${b('B02')}`, lo: 0, hi: 4 },
    clay_ratio: { assets: ['B11', 'B12'], expr: `${b('B11')}/${b('B12')}`, lo: 0.5, hi: 2.5 },
    albedo: { assets: ['B02', 'B03', 'B04'], expr: `(${b('B02')}+${b('B03')}+${b('B04')})/30000`, lo: 0, hi: 0.5 },
  };

  async function sentinel(bbox) {
    const scenes = await searchScenes('sentinel-2-l2a', bbox, 'eo:cloud_cover<15');
    for (const sc of scenes) {                       // newest scene that actually covers the AOI
      const ndvi = await rasterGrid('sentinel-2-l2a', sc.id, S2.ndvi.assets, S2.ndvi.expr, S2.ndvi.lo, S2.ndvi.hi, bbox);
      if (validFrac(ndvi) < 0.9) continue;
      const rest = await Promise.all(Object.entries(S2).filter(([k]) => k !== 'ndvi')
        .map(async ([k, d]) => [k, await rasterGrid('sentinel-2-l2a', sc.id, d.assets, d.expr, d.lo, d.hi, bbox)]));
      return { scene: sc, grids: { ndvi, ...Object.fromEntries(rest) } };
    }
    throw new Error('no cloud-free scene covers the AOI');
  }

  async function landsat(bbox) {
    const scenes = await searchScenes('landsat-c2-l2', bbox, "eo:cloud_cover<20 AND platform IN ('landsat-8','landsat-9')");
    for (const sc of scenes) {                       // ST_B10 scale: K = DN*0.00341802 + 149
      const lst = await rasterGrid('landsat-c2-l2', sc.id, ['lwir11'], 'lwir11_b1*0.00341802-124.15', 0, 70, bbox);
      if (validFrac(lst) >= 0.9) return { scene: sc, grids: { lst_c: lst } };
    }
    throw new Error('no cloud-free thermal scene covers the AOI');
  }

  // ---- terrain -----------------------------------------------------------------------------
  async function terrain(cells) {
    const elev = [];
    for (let i = 0; i < cells.length; i += 100) {
      const part = cells.slice(i, i + 100);
      const q = `latitude=${part.map((c) => c.lat.toFixed(5)).join(',')}&longitude=${part.map((c) => c.lng.toFixed(5)).join(',')}`;
      elev.push(...(await getJSON(`https://api.open-meteo.com/v1/elevation?${q}`)).elevation);
    }
    const at = (r, c) => elev[Math.min(N - 1, Math.max(0, r)) * N + Math.min(N - 1, Math.max(0, c))];
    const cellM = (2 * HALF_KM * 1000) / N;
    const tpi = [], slope = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      let s = 0, n = 0;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { s += at(r + dr, c + dc); n++; }
      tpi.push(at(r, c) - s / n);                                   // + ridge, - valley
      const dzdx = (at(r, c + 1) - at(r, c - 1)) / (2 * cellM), dzdy = (at(r + 1, c) - at(r - 1, c)) / (2 * cellM);
      slope.push((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI);
    }
    return { elevation_m: elev, tpi_m: tpi, slope_deg: slope };
  }

  // ---- geology -----------------------------------------------------------------------------
  async function geology(bbox) {
    const G = 4, pts = [];
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
      pts.push({ lat: bbox[3] - ((r + 0.5) / G) * (bbox[3] - bbox[1]), lng: bbox[0] + ((c + 0.5) / G) * (bbox[2] - bbox[0]) });
    }
    const units = await Promise.all(pts.map(async (p) => {
      const d = (await getJSON(`https://macrostrat.org/api/v2/geologic_units/map?lat=${p.lat.toFixed(4)}&lng=${p.lng.toFixed(4)}`)).success.data;
      const u = d[d.length - 1] || null;                            // last = most detailed source available
      return u && { name: u.name, lith: u.lith || '', age: u.best_int_name || '', t_age: u.t_age, b_age: u.b_age, color: u.color || '#999', source_id: u.source_id, descrip: u.descrip || '' };
    }));
    return (r, c) => units[Math.floor((r / N) * G) * G + Math.floor((c / N) * G)];
  }

  // ---- climate (AOI level) -----------------------------------------------------------------
  async function climate(aoi) {
    const iso = (d) => d.toISOString().slice(0, 10);
    const end = new Date(Date.now() - 6 * 864e5), start = new Date(end - 364 * 864e5);
    const d = await getJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${aoi.lat}&longitude=${aoi.lng}&start_date=${iso(start)}&end_date=${iso(end)}&daily=precipitation_sum,soil_moisture_0_to_7cm_mean&timezone=auto`);
    const months = {};
    d.daily.time.forEach((t, i) => { const k = t.slice(0, 7); months[k] = (months[k] || 0) + (d.daily.precipitation_sum[i] || 0); });
    const sm = d.daily.soil_moisture_0_to_7cm_mean.filter((v) => v != null);
    const last30 = sm.slice(-30);
    return {
      period: `${iso(start)} → ${iso(end)}`,
      rainfall_mm_yr: Math.round(Object.values(months).reduce((s, v) => s + v, 0)),
      rain_days_over_20mm: d.daily.precipitation_sum.filter((v) => v > 20).length,
      monthly_rain_mm: Object.entries(months).map(([month, mm]) => ({ month, mm: Math.round(mm) })),
      soil_moisture_m3m3_last30d: round(last30.reduce((s, v) => s + v, 0) / (last30.length || 1)),
      soil_moisture_m3m3_min: round(Math.min(...sm)), soil_moisture_m3m3_max: round(Math.max(...sm)),
    };
  }

  // ---- existing workings -------------------------------------------------------------------
  async function workings(bbox) {
    const pad = 0.02, bb = `${bbox[1] - pad},${bbox[0] - pad},${bbox[3] + pad},${bbox[2] + pad}`;
    const ql = `[out:json][timeout:25];(way[landuse=quarry](${bb});way[industrial=mine](${bb});nwr[man_made~"^(mineshaft|adit)$"](${bb}););out geom tags;`;
    let lastErr;
    for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
      try {
        const d = await getJSON(ep, { method: 'POST', body: new URLSearchParams({ data: ql }) }, 30000);
        return {
          type: 'FeatureCollection',
          features: d.elements.filter((e) => e.geometry || e.lat).map((e) => ({
            type: 'Feature',
            properties: { osm_id: `${e.type}/${e.id}`, name: e.tags?.name || e.tags?.operator || 'Unnamed working', resource: e.tags?.resource || '', kind: e.tags?.man_made || e.tags?.landuse || e.tags?.industrial },
            geometry: e.geometry ? { type: 'Polygon', coordinates: [e.geometry.map((g) => [g.lon, g.lat])] } : { type: 'Point', coordinates: [e.lon, e.lat] },
          })),
        };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  function distKm(cell, fc) {
    let best = Infinity;
    const kx = KM * Math.cos((cell.lat * Math.PI) / 180);
    fc.features.forEach((f) => (f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates[0])
      .forEach(([x, y]) => { best = Math.min(best, Math.hypot((x - cell.lng) * kx, (y - cell.lat) * KM)); }));
    return best;
  }

  // ---- orchestration -----------------------------------------------------------------------
  async function analyse(aoi, onStep = () => {}) {
    const bbox = bboxOf(aoi).map((v) => +v.toFixed(6));
    const dx = (bbox[2] - bbox[0]) / N, dy = (bbox[3] - bbox[1]) / N;
    const cells = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ r, c, lng: bbox[0] + (c + 0.5) * dx, lat: bbox[3] - (r + 0.5) * dy });

    const sources = [];
    const run = async (key, label, provider, fn, describe) => {
      onStep(key, 'loading', label);
      const t0 = performance.now();
      try {
        const v = await fn();
        const src = { key, label, provider, status: 'live', fetched_at: new Date().toISOString(), ms: Math.round(performance.now() - t0), ...describe(v) };
        sources.push(src); onStep(key, 'ok', label, src.detail);
        return v;
      } catch (e) {
        sources.push({ key, label, provider, status: 'unavailable', error: String(e.message || e) });
        onStep(key, 'fail', label, String(e.message || e));
        return null;
      }
    };

    const [s2, ls, topo, geo, clim, osm] = await Promise.all([
      run('sentinel2', 'Sentinel-2 L2A multispectral', 'Microsoft Planetary Computer', () => sentinel(bbox), (v) => ({ scene_id: v.scene.id, acquired: v.scene.datetime, cloud_cover_pct: round(v.scene.cloud, 1), detail: `${v.scene.datetime.slice(0, 10)} · ${round(v.scene.cloud, 1)}% cloud` })),
      run('landsat', 'Landsat 8/9 thermal (LST)', 'Microsoft Planetary Computer', () => landsat(bbox), (v) => ({ scene_id: v.scene.id, acquired: v.scene.datetime, cloud_cover_pct: round(v.scene.cloud, 1), detail: `${v.scene.datetime.slice(0, 10)} · ${v.scene.platform}` })),
      run('dem', 'Copernicus DEM terrain', 'Open-Meteo elevation API', () => terrain(cells), (v) => ({ detail: `${Math.round(Math.min(...v.elevation_m))}–${Math.round(Math.max(...v.elevation_m))} m` })),
      run('geology', 'Geologic map units', 'Macrostrat (CC-BY 4.0)', () => geology(bbox), () => ({ detail: 'regional-scale map', resolution_note: 'Global/regional compilation — coarse at mine scale' })),
      run('climate', 'Rainfall & soil moisture (ERA5-Land)', 'Open-Meteo archive API', () => climate(aoi), (v) => ({ detail: `${v.rainfall_mm_yr} mm / 12 mo`, resolution_note: '~10 km grid: one value for the whole AOI' })),
      run('workings', 'Existing quarries & mine workings', 'OpenStreetMap Overpass', () => workings(bbox), (v) => ({ detail: `${v.features.length} mapped features` })),
    ]);

    const features = cells.map((cell, i) => {
      const u = geo ? geo(cell.r, cell.c) : null;
      const w = cell.lng - dx / 2, e = cell.lng + dx / 2, s = cell.lat - dy / 2, n = cell.lat + dy / 2;
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]].map((p) => p.map((v) => +v.toFixed(6)))] },
        properties: {
          zone_id: `${aoi.id.toUpperCase()}-R${String(cell.r + 1).padStart(2, '0')}C${String(cell.c + 1).padStart(2, '0')}`,
          centroid: [+cell.lng.toFixed(6), +cell.lat.toFixed(6)],
          area_ha: round(((2 * HALF_KM) / N) ** 2 * 100, 1),
          ndvi: round(s2?.grids.ndvi[i]), ndwi: round(s2?.grids.ndwi[i]),
          ferric_ratio: round(s2?.grids.ferric_ratio[i]), clay_ratio: round(s2?.grids.clay_ratio[i]), albedo: round(s2?.grids.albedo[i]),
          lst_c: round(ls?.grids.lst_c[i], 1),
          elevation_m: round(topo?.elevation_m[i], 0), tpi_m: round(topo?.tpi_m[i], 1), slope_deg: round(topo?.slope_deg[i], 1),
          lithology: u ? u.name : null, lithology_class: u ? u.lith : null, geologic_age: u ? u.age : null, lithology_color: u ? u.color : null,
          dist_workings_km: osm && osm.features.length ? round(distKm(cell, osm), 2) : null,
          rainfall_mm_yr: clim ? clim.rainfall_mm_yr : null, soil_moisture_m3m3: clim ? clim.soil_moisture_m3m3_last30d : null,
        },
      };
    });

    return {
      aoi: { ...aoi, bbox, zone_size_m: Math.round((2 * HALF_KM * 1000) / N) },
      zones: { type: 'FeatureCollection', features },
      workings: osm, climate: clim, sources,
      scenes: { sentinel2: s2?.scene || null, landsat: ls?.scene || null },
    };
  }

  async function search(text) {
    const d = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(text)}&count=6&countryCode=IN`);
    return (d.results || []).map((r) => ({ id: `loc${r.id}`, name: [r.name, r.admin2, r.admin1].filter(Boolean).join(', '), lat: r.latitude, lng: r.longitude }));
  }

  const gibsDate = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
  window.DataProvider = {
    mode: 'LIVE_PUBLIC',
    bookmarks: BOOKMARKS,
    analyse, search,
    tiles: {
      sentinelTrueColour: (sceneId) => `${PC}/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=sentinel-2-l2a&item=${sceneId}&assets=visual&format=png`,
      macrostrat: 'https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png',
      gibs: (layer, level, daysAgo) => ({ url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${gibsDate(daysAgo)}/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.png`, maxNativeZoom: level, date: gibsDate(daysAgo) }),
    },
  };
})();

/* Satellite Prospecting — live Earth-observation analysis of a 4.8 km AOI (Sentinel-2, Landsat TIRS,
 * Copernicus DEM, Macrostrat, ERA5-Land, OSM) scored by the trained XGBoost prospectivity model (TreeSHAP),
 * overlaid with the sub-surface picture (lode traces, drill collars, proposed holes) → new G4 targets. */
import L from 'leaflet';
import { api } from '../lib/api.js';
import { chart } from '../lib/charts.js';
import { card, kpi, loading, errorBox, badge, src, $, $$, download } from '../lib/ui.js';
import { t, esc, num, date } from '../lib/format.js';
import { mineMeta } from '../lib/store.js';

const provider = window.DataProvider, contract = window.Layer2Contract;
const MODELS = { trained: window.TrainedProspectivityModel, knowledge: window.ProspectivityModel };
const ramp = (stops) => (x) => { x = Math.min(1, Math.max(0, x)) * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(x)), k = x - i; return `rgb(${stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * k)).join(',')})`; };
const LAYERS = [
  { id: 'prospectivity', label: 'Mn prospectivity (model)', src: 'ML', get: (p) => p.result?.prospectivity_score, fixed: [0, 100], ramp: ramp([[38, 52, 120], [72, 149, 190], [250, 240, 160], [240, 120, 60], [185, 28, 28]]) },
  { id: 'ferric_ratio', label: 'Ferric-iron / Mn-oxide ratio', src: 'Sentinel-2', get: (p) => p.ferric_ratio, ramp: ramp([[255, 245, 235], [253, 141, 60], [127, 39, 4]]) },
  { id: 'albedo', label: 'Surface albedo', src: 'Sentinel-2', get: (p) => p.albedo, ramp: ramp([[20, 20, 30], [130, 130, 140], [250, 250, 250]]) },
  { id: 'clay_ratio', label: 'Clay / hydroxyl ratio', src: 'Sentinel-2', get: (p) => p.clay_ratio, ramp: ramp([[247, 244, 249], [136, 86, 167], [63, 0, 125]]) },
  { id: 'ndvi', label: 'Vegetation index (NDVI)', src: 'Sentinel-2', get: (p) => p.ndvi, ramp: ramp([[166, 97, 26], [245, 245, 191], [26, 150, 65]]) },
  { id: 'lst_c', label: 'Land-surface temperature', src: 'Landsat 8/9', unit: '°C', get: (p) => p.lst_c, ramp: ramp([[255, 255, 178], [253, 141, 60], [189, 0, 38]]) },
  { id: 'tpi_m', label: 'Ridge position (TPI)', src: 'Copernicus DEM', unit: ' m', get: (p) => p.tpi_m, ramp: ramp([[44, 123, 182], [255, 255, 191], [215, 25, 28]]) },
  { id: 'elevation_m', label: 'Elevation', src: 'Copernicus DEM', unit: ' m', get: (p) => p.elevation_m, ramp: ramp([[0, 104, 55], [255, 255, 191], [140, 81, 10]]) },
];
const RASTERS = [
  { id: 's2', label: 'Sentinel-2 true colour (scene)', make: (a) => a.scenes.sentinel2 && L.tileLayer(provider.tiles.sentinelTrueColour(a.scenes.sentinel2.id), { maxZoom: 19 }) },
  { id: 'geo', label: 'Geological map (Macrostrat)', make: () => L.tileLayer(provider.tiles.macrostrat, { opacity: 0.55, maxZoom: 19 }) },
  { id: 'imerg', label: 'Rainfall rate · GPM IMERG', gibs: ['IMERG_Precipitation_Rate', 6, 3] },
  { id: 'smap', label: 'Soil moisture · SMAP L4', gibs: ['SMAP_L4_Analyzed_Surface_Soil_Moisture', 6, 7] },
  { id: 'modis_lst', label: 'Land temp. · MODIS', gibs: ['MODIS_Terra_Land_Surface_Temp_Day', 7, 4] },
  { id: 'modis_ndvi', label: 'Vegetation · MODIS NDVI', gibs: ['MODIS_Terra_NDVI_8Day', 9, 20] },
];
RASTERS.filter((r) => r.gibs).forEach((r) => { r.make = () => { const g = provider.tiles.gibs(...r.gibs); return L.tileLayer(g.url, { maxNativeZoom: g.maxNativeZoom, maxZoom: 19, opacity: 0.6, attribution: `NASA GIBS ${g.date}` }); }; });

function distToSegment(p, a, b) {
  const k = 111320 * Math.cos((p[0] * Math.PI) / 180), P = [p[1] * k, p[0] * 111320], A = [a[1] * k, a[0] * 111320], B = [b[1] * k, b[0] * 111320];
  const dx = B[0] - A[0], dy = B[1] - A[1], tt = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(P[0] - A[0] - tt * dx, P[1] - A[1] - tt * dy);
}

export async function mount(root, ctx) {
  const m = mineMeta(ctx.mine);
  const S = { aoi: provider.bookmarks.find((b) => b.id === m.id) || { id: m.id, name: m.name, lat: m.lat, lng: m.lng }, analysis: null, doc: null, modelKey: 'trained', layer: 'prospectivity', rasters: new Set(), selected: null, lyr: {}, picking: false, weights: { ...MODELS.knowledge.DEFAULT_WEIGHTS }, runId: 0 };
  root.innerHTML = `
    <div class="ph"><div><h2>Satellite prospecting · surface indicators</h2>
      <p>Fetched live for a 4.8 × 4.8 km area of interest, split into 256 zones of 300 m: Sentinel-2 spectral ratios (ferric-iron, clay, albedo, NDVI, NDWI), Landsat land-surface temperature, Copernicus DEM terrain, Macrostrat lithology, ERA5 rainfall &amp; soil moisture and OSM workings. The XGBoost model (trained on 8 MOIL mine areas, leave-one-mine-out ROC-AUC 0.88) ranks every zone and explains it with exact TreeSHAP; the sub-surface model is overlaid to separate known lodes from <b>new targets</b>.</p></div>
      <div class="actions"><input class="input" id="exSearch" placeholder="Search a place in India…" style="width:210px"><button class="btn" id="exPick">⌖ Pick on map</button><button class="btn primary" id="exRun">↻ Re-run live analysis</button></div></div>
    <div class="grid g-6" id="exKpis">${Array(6).fill('<div class="card skeleton" style="height:104px"></div>').join('')}</div>
    <div class="grid" style="grid-template-columns:270px minmax(0,1fr) 360px;align-items:start">
      <div class="stack">
        ${card({ title: 'Model', body: `<div class="seg" id="exModel" style="width:100%"><button data-m="trained" class="on" style="flex:1">Trained XGBoost</button><button data-m="knowledge" style="flex:1">Expert weights</button></div><div id="exWeights" class="stack small" style="margin-top:10px"></div>` })}
        ${card({ title: 'Map layers', body: `<div id="exLayers" class="stack small"></div>` })}
        ${card({ title: 'Live data feeds', sub: 'this AOI', body: '<div id="exSources" class="stack small"></div>' })}
        ${card({ title: 'Layer-2 hand-off', sub: 'moil.layer1.prospectivity', body: '<div class="grid g-2" style="gap:6px"><button class="btn sm" id="exGeo">GeoJSON</button><button class="btn sm" id="exJson">Contract JSON</button><button class="btn sm" id="exVal" style="grid-column:span 2">Validate contract</button></div><div id="exValOut" class="small" style="margin-top:8px"></div>' })}
      </div>
      <section class="card" style="position:sticky;top:0"><div class="card-h"><h3 id="exAoiName">${esc(S.aoi.name)}</h3><div class="row"><span class="small muted">zone opacity</span><input type="range" id="exOpacity" min="0.1" max="1" step="0.05" value="0.7" style="width:110px"></div></div>
        <div class="card-b flush" style="position:relative;flex:1"><div id="exMap" class="map" style="height:720px"></div></div></section>
      <div class="stack" id="exPanel">${card({ title: 'Zone intelligence', body: loading('Waiting for the live analysis…') })}</div>
    </div>
    <div class="grid g-2">
      ${card({ title: 'Surface ⇄ subsurface reconciliation', sub: 'model ranking vs mapped lodes & drilling', body: '<div id="exRecon"></div>' })}
      ${card({ title: 'Zone score distribution', sub: 'all 256 zones', body: '<div id="exHist" class="chart sm"></div>' })}
    </div>`;

  // ---------------- map
  const map = L.map($('#exMap', root), { zoomControl: true }).setView([S.aoi.lat, S.aoi.lng], 13);
  const base = {
    'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Imagery © Esri, Maxar', maxZoom: 19 }),
    'Topographic': L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OSM © CARTO', maxZoom: 19 }),
    'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OSM © CARTO', maxZoom: 19 }),
  };
  base['Satellite (Esri)'].addTo(map);
  L.control.layers(base, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => { const d = L.DomUtil.create('div', 'map-legend'); d.id = 'exLegend'; return d; };
  legend.addTo(map);

  // ---------------- subsurface overlays (backend)
  const sub = L.layerGroup().addTo(map);
  Promise.all([api(`/mines/${m.id}/geology`), api(`/mines/${m.id}/boreholes`)]).then(([geo, holes]) => {
    if (!ctx.isCurrent()) return;
    S.geo = geo;
    L.polygon(geo.lease, { color: '#ffd166', weight: 2, dashArray: '6 5', fill: false }).bindTooltip('Mining lease (indicative)', { sticky: true }).addTo(sub);
    geo.traces.forEach((tr) => L.polyline(tr.line, { color: '#ff3d7f', weight: 3.5, opacity: 0.95 }).bindTooltip(`${esc(tr.name)} — interpreted lode subcrop · strike ${geo.strike_az}°, dip ${geo.dip}° → ${geo.dip_dir}°`, { sticky: true }).addTo(sub));
    const pc = { 'Historical exploration': '#9aa1b0', 'Development infill': '#ffffff', 'Resource definition': '#7fdbff', 'Deep exploration': '#ffd166' };
    holes.forEach((h) => L.circleMarker([h.lat, h.lng], { radius: 3, color: '#111', weight: 1, fillColor: pc[h.purpose] || '#fff', fillOpacity: 1 }).bindTooltip(`<b>${h.id}</b> · ${esc(h.purpose)}<br>${h.depth_m} m, az ${h.azimuth}° dip ${h.dip}° · ${h.drilled_on.slice(0, 4)}`, { className: 'tt' }).addTo(sub));
    geo.proposals.forEach((p) => L.marker([p.collar.lat, p.collar.lng], { icon: L.divIcon({ className: '', html: '<div style="width:14px;height:14px;border-radius:50%;background:#ff3d7f;border:2px solid #fff;box-shadow:0 0 0 3px rgba(255,61,127,.35)"></div>', iconSize: [14, 14] }) })
      .bindTooltip(`<b>${p.id}</b> proposed infill hole<br>target ${p.target_depth_m} m · est. ${p.est_grade}% Mn<br>upgrades ${t(p.upgrade_tonnes)} to Indicated`, { className: 'tt' }).addTo(sub));
    if (S.doc) reconcile();
  }).catch(() => {});

  // ---------------- rendering helpers
  const range = (Ly) => { if (Ly.fixed) return Ly.fixed; const v = S.analysis.zones.features.map((f) => Ly.get(f.properties)).filter((x) => x != null).sort((a, b) => a - b); return v.length ? [v[Math.floor(v.length * 0.02)], v[Math.ceil(v.length * 0.98) - 1]] : [0, 1]; };
  const styleZones = () => {
    if (!S.lyr.zones) return;
    const Ly = LAYERS.find((l) => l.id === S.layer), [lo, hi] = range(Ly), op = +$('#exOpacity', root).value;
    S.lyr.zones.setStyle((f) => { const v = Ly.get(f.properties); const sel = S.selected?.zone_id === f.properties.zone_id;
      const k = (v - lo) / (hi - lo || 1);
      return v == null ? { stroke: false, fillOpacity: 0 } : { color: sel ? '#fff' : '#111', weight: sel ? 3 : 0.3, opacity: sel ? 1 : 0.35, fillColor: Ly.ramp(k), fillOpacity: Ly.id === 'prospectivity' ? op * (0.3 + 0.7 * Math.min(1, k * 1.6)) : op }; });
    $('#exLegend').innerHTML = `<b>${esc(Ly.label)}</b><div class="ramp" style="background:linear-gradient(90deg,${[0, 0.25, 0.5, 0.75, 1].map(Ly.ramp).join(',')})"></div><div class="ends"><span>${+(+lo).toFixed(2)}${Ly.unit || ''}</span><span>${+(+hi).toFixed(2)}${Ly.unit || ''}</span></div>
      <div style="margin-top:6px;display:grid;gap:3px"><span><i style="display:inline-block;width:16px;height:3px;background:#ff3d7f;vertical-align:middle;margin-right:5px"></i>Lode subcrop</span><span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fff;border:1px solid #111;margin-right:5px"></i>Drill collar</span><span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff3d7f;margin-right:5px"></i>Proposed hole</span></div>`;
  };
  const renderLayersPanel = () => {
    const has = (l) => S.analysis && S.analysis.zones.features.some((f) => l.get(f.properties) != null);
    $('#exLayers', root).innerHTML = `<div class="muted" style="font-weight:600">Zone layer (300 m)</div>${LAYERS.map((l) => `<label class="check"><input type="radio" name="zl" value="${l.id}" ${S.layer === l.id ? 'checked' : ''} ${S.analysis && !has(l) ? 'disabled' : ''}><span>${esc(l.label)} <span class="faint">· ${l.src}</span></span></label>`).join('')}
      <div class="muted" style="font-weight:600;margin-top:6px">Satellite rasters</div>${RASTERS.map((r) => `<label class="check"><input type="checkbox" data-r="${r.id}" ${S.rasters.has(r.id) ? 'checked' : ''}><span>${esc(r.label)}</span></label>`).join('')}
      <label class="check" style="margin-top:6px"><input type="checkbox" id="exSub" checked><span><b>Sub-surface overlay</b> (lodes, holes)</span></label>`;
    $$('#exLayers input[name=zl]', root).forEach((i) => i.addEventListener('change', () => { S.layer = i.value; styleZones(); }));
    $$('#exLayers [data-r]', root).forEach((i) => i.addEventListener('change', () => { const r = RASTERS.find((x) => x.id === i.dataset.r); if (i.checked) { S.rasters.add(r.id); S.lyr[r.id] ||= r.make(S.analysis || {}); S.lyr[r.id]?.addTo(map); S.lyr.zones?.bringToFront(); } else { S.rasters.delete(r.id); S.lyr[r.id] && map.removeLayer(S.lyr[r.id]); } }));
    $('#exSub', root).addEventListener('change', (e) => (e.target.checked ? sub.addTo(map) : map.removeLayer(sub)));
  };
  renderLayersPanel();
  $('#exOpacity', root).addEventListener('input', styleZones);

  // ---------------- scoring
  const rescore = () => {
    const model = MODELS[S.modelKey];
    const eff = model.scoreAll(S.analysis.zones.features, S.modelKey === 'knowledge' ? S.weights : undefined);
    S.doc = contract.build(S.analysis, model, eff);
    if (S.selected) S.selected = S.doc.zones.find((z) => z.zone_id === S.selected.zone_id);
    styleZones(); renderKpis(); renderPanel(); renderWeights(eff); reconcile(); renderHist();
  };
  const renderWeights = (eff) => {
    if (S.modelKey === 'trained') {
      const card = MODELS.trained.card;
      $('#exWeights', root).innerHTML = `<div class="note brand">XGBoost · 200 trees · trained ${date(card.trained_at?.slice(0, 10))}. Leave-one-mine-out ROC-AUC <b>${card.validation?.models?.xgboost?.roc_auc ?? 0.875}</b> vs <b>${card.validation?.models?.['expert_index (no training)']?.roc_auc ?? 0.42}</b> for the expert index. Global importance (mean |SHAP|):</div>
        ${Object.entries(eff).sort((a, b) => b[1] - a[1]).map(([k, w]) => `<div class="row between"><span>${esc(MODELS.trained.factors.find((f) => f.key === k)?.label || k)}</span><b class="mono">${(w * 100).toFixed(0)}%</b></div><div class="mini-bar"><i style="width:${w * 100 / Math.max(...Object.values(eff))}%;background:var(--brand)"></i></div>`).join('')}`;
    } else {
      $('#exWeights', root).innerHTML = `<div class="note">Knowledge-driven weighted overlay (no training). Adjust weights to test geological hypotheses.</div>` + MODELS.knowledge.factors.map((f) => `<div class="field"><label>${esc(f.label)} <b>${f.key in eff ? `${Math.round(eff[f.key] * 100)}%` : 'n/a'}</b></label><input type="range" min="0" max="0.4" step="0.01" value="${S.weights[f.key]}" data-w="${f.key}"></div>`).join('') + '<button class="btn sm" id="exResetW">Reset weights</button>';
      $$('#exWeights [data-w]', root).forEach((r) => r.addEventListener('change', () => { S.weights[r.dataset.w] = +r.value; rescore(); }));
      $('#exResetW', root)?.addEventListener('click', () => { S.weights = { ...MODELS.knowledge.DEFAULT_WEIGHTS }; rescore(); });
    }
  };
  $$('#exModel button', root).forEach((b) => b.addEventListener('click', () => { $$('#exModel button', root).forEach((x) => x.classList.toggle('on', x === b)); S.modelKey = b.dataset.m; if (S.analysis) rescore(); }));

  const renderKpis = () => {
    const s = S.doc.summary, sc = S.analysis.scenes, cl = S.analysis.climate, top = S.doc.zones.find((z) => z.drill_priority_rank === 1);
    const live = S.analysis.sources.filter((x) => x.status === 'live').length;
    $('#exKpis', root).innerHTML = [
      kpi({ label: 'High-prospectivity zones', value: s.high, unit: `/ ${s.zone_count}`, tone: 'low', foot: `${num(s.high_prospectivity_area_ha)} ha · ${s.moderate} moderate` }),
      kpi({ label: 'Top target', value: top ? num(top.prospectivity_score, 0) : '—', unit: '/100', foot: top ? `${esc(top.zone_id)} · ${top.confidence} confidence` : '' }),
      kpi({ label: 'New targets (off known lodes)', value: '<span id="exNewT">…</span>', foot: 'High zones > 300 m from mapped lode / workings' }),
      kpi({ label: 'Sentinel-2 scene', value: sc.sentinel2 ? date(sc.sentinel2.datetime.slice(0, 10)) : 'n/a', foot: sc.sentinel2 ? `${num(sc.sentinel2.cloud, 1)}% cloud · ${esc(sc.sentinel2.platform || '')}` : 'unavailable' }),
      kpi({ label: 'Landsat thermal scene', value: sc.landsat ? date(sc.landsat.datetime.slice(0, 10)) : 'n/a', foot: sc.landsat ? esc(sc.landsat.platform) : 'unavailable' }),
      kpi({ label: 'Live sources', value: `${live}/${S.analysis.sources.length}`, tone: live === S.analysis.sources.length ? 'low' : 'high', foot: cl ? `rain ${num(cl.rainfall_mm_yr)} mm / 12 mo` : 'climate n/a' }),
    ].join('');
  };

  const reconcile = () => {
    if (!S.doc || !S.geo) return;
    const traces = S.geo.traces.map((tr) => tr.line);
    const osm = S.analysis.workings?.features || [];
    const zones = S.doc.zones.filter((z) => z.prospectivity_class === 'High');
    const classify = (z) => {
      const c = [z.centroid[1], z.centroid[0]];
      const dl = Math.min(...traces.map((l) => distToSegment(c, l[0], l[1])));
      return { z, dLode: dl, nearWork: z.features.dist_workings_km != null && z.features.dist_workings_km < 0.3 };
    };
    const rows = zones.map(classify);
    const confirm = rows.filter((r) => r.dLode <= 300), fresh = rows.filter((r) => r.dLode > 300 && !r.nearWork);
    const potential = fresh.reduce((s, r) => s + (r.z.prospectivity_score / 100) * 300 * 100 * 3 * 3.9, 0);
    if ($('#exNewT')) $('#exNewT').textContent = fresh.length;
    $('#exRecon', root).innerHTML = `
      <div class="grid g-3" style="gap:10px;margin-bottom:12px">
        <div class="note"><b class="mono" style="font-size:18px">${confirm.length}</b><br>High zones on a known lode (≤300 m) — the satellite model independently <b>confirms</b> the drilled ore body.</div>
        <div class="note brand"><b class="mono" style="font-size:18px">${fresh.length}</b><br>High zones <b>away</b> from lodes &amp; workings — new reconnaissance targets.</div>
        <div class="note"><b class="mono" style="font-size:18px">${t(potential)}</b><br>Indicative G4 / UNFC 334 potential (300 m strike × 100 m depth × 3 m × 3.9 t/m³ × P).</div></div>
      <div class="tbl-wrap" style="max-height:230px"><table class="tbl"><thead><tr><th>Zone</th><th class="num">Score</th><th>Confidence</th><th class="num">To lode</th><th>Status</th></tr></thead><tbody>
      ${rows.sort((a, b) => b.z.prospectivity_score - a.z.prospectivity_score).slice(0, 14).map((r) => `<tr class="clickable" data-z="${r.z.zone_id}"><td class="mono">${r.z.zone_id}</td><td class="num"><b>${num(r.z.prospectivity_score, 1)}</b></td><td>${r.z.confidence}</td><td class="num">${Math.round(r.dLode)} m</td>
        <td>${r.dLode <= 300 ? badge('low', 'confirms lode') : r.nearWork ? badge('neutral', 'existing working') : badge('brand', 'NEW TARGET')}</td></tr>`).join('')}</tbody></table></div>
      <div class="small muted" style="margin-top:6px">${osm.length} OSM-mapped workings in the AOI. G4 potential is a reconnaissance indication only — it enters the resource statement only after pitting / drilling.</div>`;
    $$('#exRecon tr[data-z]', root).forEach((tr) => tr.addEventListener('click', () => selectZone(tr.dataset.z, true)));
  };

  const renderHist = () => {
    const sc = S.doc.zones.map((z) => z.prospectivity_score), bins = Array(10).fill(0);
    sc.forEach((s) => { bins[Math.min(9, Math.floor(s / 10))]++; });
    chart($('#exHist', root), (p) => ({ legend: false, xAxis: { type: 'category', data: bins.map((_, i) => `${i * 10}–${i * 10 + 10}`) }, yAxis: { type: 'value', name: 'zones' },
      series: [{ type: 'bar', data: bins.map((b, i) => ({ value: b, itemStyle: { color: LAYERS[0].ramp(i / 9), borderRadius: [3, 3, 0, 0] } })), barMaxWidth: 34 }] }));
  };

  // ---------------- zone panel
  const renderPanel = () => {
    const z = S.selected;
    if (!z) {
      const top = [...S.doc.zones].sort((a, b) => a.drill_priority_rank - b.drill_priority_rank).slice(0, 10);
      $('#exPanel', root).innerHTML = card({ title: 'Ranked targets', sub: 'click a row or any zone on the map', body: `<table class="tbl"><thead><tr><th>#</th><th>Zone</th><th class="num">Score</th><th>Conf.</th></tr></thead><tbody>
        ${top.map((z2) => `<tr class="clickable" data-z="${z2.zone_id}"><td class="mono">${z2.drill_priority_rank}</td><td class="mono">${z2.zone_id}</td><td class="num"><b>${num(z2.prospectivity_score, 1)}</b></td><td>${badge(z2.confidence === 'High' ? 'low' : z2.confidence === 'Medium' ? 'medium' : 'high', z2.confidence)}</td></tr>`).join('')}</tbody></table>`, bodyCls: 'flush' });
      $$('#exPanel tr[data-z]', root).forEach((tr) => tr.addEventListener('click', () => selectZone(tr.dataset.z, true)));
      return;
    }
    const f = z.features, ev = z.evidence.filter((e) => e.factor !== 'base_rate');
    $('#exPanel', root).innerHTML = card({ title: `Zone ${esc(z.zone_id)}`, right: `<button class="btn sm" id="exBack">← Ranked list</button>`, body: `
      <div class="row" style="gap:14px;align-items:center"><div style="font-size:34px;font-weight:800;font-family:var(--mono);color:${LAYERS[0].ramp(z.prospectivity_score / 100)}">${num(z.prospectivity_score, 1)}</div>
        <div><div>${badge(z.prospectivity_class === 'High' ? 'low' : z.prospectivity_class === 'Moderate' ? 'medium' : 'neutral', `${z.prospectivity_class} prospectivity`)} ${badge('neutral', `${z.confidence} confidence`)}</div>
        <div class="small muted mono" style="margin-top:4px">${z.centroid[1]}°N ${z.centroid[0]}°E · rank #${z.drill_priority_rank}</div></div></div>
      <div class="note brand" style="margin-top:10px"><b>Recommended:</b> ${esc(z.recommended_action)}</div>
      <div class="small" style="margin-top:10px;line-height:1.5">${esc(z.explanation)}</div>
      <div id="exShap" class="chart sm" style="margin-top:6px"></div>
      <dl class="kv" style="margin-top:6px">
        <dt>Ferric ratio (B4/B2)</dt><dd>${num(f.ferric_ratio, 3)}</dd><dt>Clay ratio (B11/B12)</dt><dd>${num(f.clay_ratio, 3)}</dd><dt>Albedo</dt><dd>${num(f.albedo, 3)}</dd>
        <dt>NDVI · NDWI</dt><dd>${num(f.ndvi, 2)} · ${num(f.ndwi, 2)}</dd><dt>Land-surface temp.</dt><dd>${num(f.lst_c, 1)} °C</dd><dt>Elevation · slope</dt><dd>${num(f.elevation_m)} m · ${num(f.slope_deg, 1)}°</dd>
        <dt>Ridge position (TPI)</dt><dd>${num(f.tpi_m, 1)} m</dd><dt>Lithology</dt><dd style="font-family:var(--font);font-size:11.5px">${esc(f.lithology || 'n/a')}</dd><dt>Nearest working</dt><dd>${f.dist_workings_km == null ? 'n/a' : `${num(f.dist_workings_km, 2)} km`}</dd></dl>
      <button class="btn sm" id="exZoneJson" style="margin-top:10px">Export zone JSON</button>` });
    $('#exBack', root).addEventListener('click', () => selectZone(null));
    $('#exZoneJson', root).addEventListener('click', () => { const { zones, ...meta } = S.doc; download(`${z.zone_id}.json`, JSON.stringify({ ...meta, zones: [z] }, null, 2), 'application/json'); });
    chart($('#exShap', root), (p) => ({ legend: false, grid: { left: 6, right: 30, top: 6, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${v > 0 ? '+' : ''}${v} pts` },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: ev.map((e) => e.label.replace(/\(.*\)/, '').trim()), axisLabel: { fontSize: 10, width: 130, overflow: 'truncate' }, inverse: true },
      series: [{ type: 'bar', data: ev.map((e) => ({ value: +e.contribution.toFixed(2), itemStyle: { color: e.contribution >= 0 ? p.low : p.crit, borderRadius: 3 } })), barMaxWidth: 12, label: { show: true, position: 'right', fontSize: 9.5, color: p.muted, formatter: (d) => `${d.value > 0 ? '+' : ''}${d.value}` } }] }));
  };
  const selectZone = (id, pan) => {
    S.selected = id ? S.doc.zones.find((z) => z.zone_id === id) : null;
    styleZones(); renderPanel();
    if (pan && S.selected) map.panTo([S.selected.centroid[1], S.selected.centroid[0]]);
  };

  // ---------------- analysis run
  const analyse = async (aoi) => {
    const run = ++S.runId;
    S.aoi = aoi; S.selected = null; S.doc = null;
    Object.entries(S.lyr).forEach(([, l]) => l && map.removeLayer(l)); S.lyr = {};
    $('#exAoiName', root).textContent = aoi.name;
    $('#exSources', root).innerHTML = '';
    $('#exPanel', root).innerHTML = card({ title: 'Live analysis running', body: loading('Acquiring Earth-observation data…', 'Sentinel-2 · Landsat · DEM · geology · ERA5 · OSM (20–60 s)') });
    map.flyTo([aoi.lat, aoi.lng], 13, { duration: 0.6 });
    const analysis = await provider.analyse(aoi, (key, status, label, detail) => {
      if (run !== S.runId || !ctx.isCurrent()) return;
      let el = root.querySelector(`#exsrc-${key}`);
      if (!el) { el = document.createElement('div'); el.id = `exsrc-${key}`; $('#exSources', root).appendChild(el); }
      el.innerHTML = `<div class="row" style="gap:7px"><span class="dot ${status === 'ok' ? 'ok' : status === 'loading' ? 'warn pulse' : 'bad'}"></span><span style="flex:1"><b>${esc(label)}</b><br><span class="muted">${status === 'loading' ? 'fetching…' : esc(detail || '')}</span></span></div>`;
    });
    if (run !== S.runId || !ctx.isCurrent()) return;
    S.analysis = analysis;
    S.lyr.zones = L.geoJSON(analysis.zones, { onEachFeature: (f, l) => { l.on('click', () => { if (!S.picking) selectZone(f.properties.zone_id); }); l.bindTooltip(() => `<b>${f.properties.zone_id}</b><br>score ${num(f.properties.result?.prospectivity_score, 1)} · ${f.properties.result?.prospectivity_class}`, { sticky: true, className: 'tt' }); } }).addTo(map);
    if (analysis.workings) S.lyr.workings = L.geoJSON(analysis.workings, { style: { color: '#ffb703', weight: 2, dashArray: '4 3', fillOpacity: 0.08 }, pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 4, color: '#ffb703' }) }).bindTooltip((l) => esc(l.feature.properties.name)).addTo(map);
    S.rasters.forEach((id) => { const r = RASTERS.find((x) => x.id === id); S.lyr[id] = r.make(analysis); S.lyr[id]?.addTo(map); });
    S.lyr.zones.bringToFront(); sub.eachLayer((l) => l.bringToFront?.());
    renderLayersPanel();
    rescore();
    map.fitBounds(S.lyr.zones.getBounds(), { padding: [10, 10] });
  };

  // ---------------- controls
  $('#exRun', root).addEventListener('click', () => analyse(S.aoi));
  $('#exPick', root).addEventListener('click', () => { S.picking = !S.picking; $('#exPick', root).classList.toggle('primary', S.picking); map.getContainer().style.cursor = S.picking ? 'crosshair' : ''; });
  map.on('click', (e) => { if (!S.picking) return; S.picking = false; $('#exPick', root).classList.remove('primary'); map.getContainer().style.cursor = '';
    analyse({ id: `pt${Math.abs(Math.round(e.latlng.lat * 1000))}_${Math.abs(Math.round(e.latlng.lng * 1000))}`, name: `Custom AOI ${e.latlng.lat.toFixed(3)}°N ${e.latlng.lng.toFixed(3)}°E`, lat: +e.latlng.lat.toFixed(5), lng: +e.latlng.lng.toFixed(5) }); });
  let st;
  $('#exSearch', root).addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; clearTimeout(st); const q = e.target.value.trim(); if (q.length < 3) return;
    provider.search(q).then((res) => { if (res[0]) analyse(res[0]); }).catch(() => {}); });
  $('#exGeo', root).addEventListener('click', () => S.doc && download(`${S.aoi.id}_prospectivity.geojson`, JSON.stringify(contract.toGeoJSON(S.doc)), 'application/geo+json'));
  $('#exJson', root).addEventListener('click', () => S.doc && download(`${S.aoi.id}_layer1_contract.json`, JSON.stringify(S.doc, null, 2), 'application/json'));
  $('#exVal', root).addEventListener('click', () => { if (!S.doc) return; const r = contract.validate(S.doc);
    $('#exValOut', root).innerHTML = `<div class="${r.valid ? 'note' : 'err'}" style="margin-bottom:6px"><b>${r.valid ? '✔ Conforms' : '✘ Violates'}</b> ${contract.CONTRACT} v${contract.SCHEMA_VERSION}</div>${r.checks.map((c) => `<div class="row between" style="color:${c.ok ? 'var(--low)' : 'var(--crit)'}"><span>${c.ok ? '✔' : '✘'} ${esc(c.name)}</span><span class="muted">${esc(c.detail)}</span></div>`).join('')}`; });

  analyse(S.aoi).catch((e) => { $('#exPanel', root).innerHTML = errorBox(e); });
  return () => { S.runId++; map.remove(); };
}

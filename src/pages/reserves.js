/* Subsurface & Reserves — drilling → intercepts → variography → kriging → UNFC classification → 3D model,
 * longitudinal section, grade-tonnage, mine life, proposed infill drilling and borehole logs. */
import { api } from '../lib/api.js';
import { chart } from '../lib/charts.js';
import { card, kpi, loading, errorBox, badge, src, $, $$ } from '../lib/ui.js';
import { t, pct, esc, num, inr } from '../lib/format.js';
import { mineMeta } from '../lib/store.js';
import { ReserveViewer, UNFC_COLORS, GRADE_LEGEND, gradeColor } from '../three/reserve-viewer.js';

const UNFC_ORDER = ['111', '122', '331', '332', '333'];
const LITH_COLORS = { 'Soil / lateritic cap': '#c9a36b', 'Mica schist (hanging wall)': '#9aa8b8', 'Mn ore (braunite–pyrolusite)': '#2b1d33', 'Gondite (Mn-silicate halo)': '#a0708f', 'Quartzite / gondite (footwall)': '#d9d2c3' };

export async function mount(root, ctx) {
  const m = mineMeta(ctx.mine);
  root.innerHTML = `
    <div class="ph"><div><h2>${esc(m.name)} · subsurface model &amp; reserves</h2>
      <p>Sub-surface indicators: every drill hole is logged and assayed; ore intercepts become true-thickness × grade pierce points on each lode, which are kriged on 25 m panels and classified to UNFC (111 Proved · 122 Probable reserves; 331/332/333 resources) against the approved mining depth, 25% Mn cut-off and 1.5 m minimum width. Proved reserves are depleted by the tonnes actually mined.</p></div>
      <div class="actions">${src('sim', 'Drilling DB: simulated')} ${src('real', 'Terrain: Copernicus DEM')} ${src('ml', 'Ordinary kriging')}</div></div>
    <div class="grid g-6" id="rsKpis">${Array(6).fill('<div class="card skeleton" style="height:112px"></div>').join('')}</div>
    <div class="grid g-main-side">
      ${card({ title: '3D geological block model', sub: 'drag to orbit · scroll to zoom · hover a panel', right: '<div class="seg" id="rsMode"><button data-m="unfc" class="on">UNFC class</button><button data-m="grade">Mn grade</button><button data-m="thickness">Thickness</button></div>',
        body: `<div class="viewer3d" id="rsViewer"><div class="viewer-hud"><div class="panel" id="rsLegend"></div></div><div class="viewer-tip" id="rsTip" hidden></div><div class="viewer-hint">vertical scale ×<span id="rsExagL">1</span> · terrain = Copernicus DEM</div>${loading('Building block model…')}</div>`, bodyCls: 'flush' })}
      <div class="stack">
        ${card({ title: 'Model layers', body: `<div class="stack" id="rsLayers">
          ${[['ore', 'Ore panels (kriged)', true], ['depleted', 'Mined-out ground', true], ['holes', 'Drill holes & assays', true], ['proposals', 'Proposed infill holes', true], ['terrain', 'Terrain surface (DEM)', true], ['levels', 'Mined-out & approved depth levels', true]]
            .map(([k, l, on]) => `<label class="check"><input type="checkbox" data-layer="${k}" ${on ? 'checked' : ''}><span>${l}</span></label>`).join('')}
          <div class="field"><label>Strike cut-away <b id="rsCutL">off</b></label><input type="range" id="rsCut" min="0" max="100" value="100"></div>
          <div class="field"><label>Vertical exaggeration <b id="rsExagV">1×</b></label><input type="range" id="rsExag" min="1" max="3" step="0.5" value="1"></div>
          <button class="btn sm" id="rsReset">Reset view</button></div>` })}
        ${card({ title: 'Resource statement', sub: 'UNFC · AI-assisted, uncertified', body: `<div id="rsUnfc">${loading()}</div>` })}
      </div>
    </div>
    ${card({ title: 'Longitudinal section', sub: 'panels in the plane of the lode · looking along dip', right: '<div class="row"><div class="seg" id="rsLsMode"><button data-m="grade" class="on">Grade</button><button data-m="unfc">Class</button><button data-m="T">Thickness</button></div><div class="seg" id="rsLens"></div></div>', body: '<div id="rsLS" class="chart xl"></div>' })}
    <div class="grid g-3">
      ${card({ title: 'Grade–tonnage curve', sub: 'all non-depleted estimated panels', body: '<div id="rsGT" class="chart"></div>' })}
      ${card({ title: 'Variogram · true thickness', sub: 'experimental points & fitted spherical model', body: '<div id="rsVario" class="chart"></div>' })}
      ${card({ title: 'Reserve depletion & mine life', sub: 'Proved + Probable at plan rate', body: '<div id="rsLife" class="chart"></div>' })}
    </div>
    <div class="grid g-3-2">
      ${card({ title: 'Proposed infill drilling', sub: 'converts Inferred (333) to Indicated inside / near the mining limit', body: `<div class="tbl-wrap" id="rsProp">${loading()}</div>`, bodyCls: 'flush' })}
      ${card({ title: 'Drill-hole log', sub: 'lithology & assays down the hole', right: '<select class="input" id="rsHole"></select>', body: '<div id="rsLog" class="chart lg"></div>' })}
    </div>`;

  let viewer;
  try {
    const r = await api(`/mines/${m.id}/reserves/scene`, { ttl: 10 * 60e3 });
    if (!ctx.isCurrent()) return;
    const S = r.summary;
    const cls = Object.fromEntries(S.classes.map((c) => [c.code, c]));
    $('#rsKpis', root).innerHTML = [
      kpi({ label: 'Ore reserves (111+122)', value: t(S.reserves.tonnes, { unit: false }), unit: 'Mt', foot: `@ ${num(S.reserves.grade, 1)}% Mn · after ${t(S.depleted_since_ref_t)} mined` }),
      kpi({ label: 'Resources (331–333)', value: t(S.resources.tonnes, { unit: false }), unit: 'Mt', foot: `@ ${num(S.resources.grade, 1)}% Mn · Inferred ${t(cls['333'].tonnes)}` }),
      kpi({ label: 'Mine life at plan', value: num(S.mine_life_years, 1), unit: 'years', tone: S.mine_life_years < 15 ? 'high' : 'low', foot: `plan ${t(m.annual_plan_t)} / yr` }),
      kpi({ label: 'Contained manganese', value: t(S.contained_mn_t, { unit: false }), unit: S.contained_mn_t >= 1e6 ? 'Mt' : 'kt', foot: 'reserves + resources' }),
      kpi({ label: 'Drilling', value: num(S.holes), unit: 'holes', foot: `${num(S.metres)} m · ${S.intercepts} ore intercepts · ${S.barren} barren` }),
      kpi({ label: 'Exploration upside', value: t(r.proposals.reduce((s, p) => s + p.upgrade_tonnes, 0), { unit: false }), unit: 'Mt', tone: 'low', foot: `convertible with ${r.proposals.length} infill holes · ${inr(r.proposals.reduce((s, p) => s + p.cost_lakh, 0))}` }),
    ].join('');

    // ---- 3D
    const vEl = $('#rsViewer', root);
    vEl.querySelector('.loading-block')?.remove();
    const tip = $('#rsTip', root);
    viewer = new ReserveViewer(vEl, {
      onHover: (h) => {
        if (!h) { tip.hidden = true; return; }
        const p = h.panel; tip.hidden = false; tip.style.left = `${h.x + 14}px`; tip.style.top = `${h.y + 10}px`;
        tip.innerHTML = `<b>Lode ${p.lens} · panel</b><br>Mn grade <b>${p.grade}%</b><br>True thickness <b>${p.T} m</b><br>Depth <b>${p.depth} m</b><br>Tonnes <b>${t(p.tonnes)}</b><br>Class ${badge('neutral', p.unfc)} · ${p.confidence}<br><span class="muted small">kriging variance ${p.kv} · drill spacing ${p.d3} m</span>`;
      },
    });
    viewer.load(r);
    const legend = () => {
      const mode = viewer.mode;
      $('#rsLegend', root).innerHTML = mode === 'grade'
        ? `<b class="small">Mn grade</b><div style="display:flex;gap:2px;margin-top:4px">${GRADE_LEGEND.map((g) => `<div style="text-align:center"><div style="width:30px;height:10px;border-radius:2px;background:${g.css}"></div><span class="small mono">${g.g}</span></div>`).join('')}</div>`
        : mode === 'thickness' ? '<b class="small">True thickness</b><div style="height:10px;width:170px;border-radius:3px;margin-top:4px;background:linear-gradient(90deg,hsl(259,70%,50%),hsl(150,70%,50%),hsl(40,70%,50%))"></div><div class="row between small mono" style="width:170px"><span>0 m</span><span>7</span><span>14 m</span></div>'
          : `<b class="small">UNFC class</b>${[...UNFC_ORDER, 'Below cut-off'].map((c) => `<div class="small"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${UNFC_COLORS[c]};margin-right:6px"></i>${c}${cls[c] ? ` · ${t(cls[c].tonnes)}` : ''}</div>`).join('')}<div class="small"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${UNFC_COLORS.Depleted};opacity:.5;margin-right:6px"></i>Mined out</div>`;
    };
    legend();
    $$('#rsMode button', root).forEach((b) => b.addEventListener('click', () => { $$('#rsMode button', root).forEach((x) => x.classList.toggle('on', x === b)); viewer.setMode(b.dataset.m); legend(); }));
    $$('#rsLayers [data-layer]', root).forEach((cb) => cb.addEventListener('change', () => viewer.setVisible(cb.dataset.layer, cb.checked)));
    const half = r.frame.strike_len_m / 2 + 100;
    $('#rsCut', root).addEventListener('input', (e) => { const v = +e.target.value; const u = v >= 100 ? null : -half + (v / 100) * 2 * half; $('#rsCutL', root).textContent = u == null ? 'off' : `${Math.round(u)} m along strike`; viewer.setClip(u); });
    $('#rsExag', root).addEventListener('change', (e) => { $('#rsExagV', root).textContent = `${e.target.value}×`; $('#rsExagL', root).textContent = e.target.value; viewer.setExaggeration(+e.target.value); });
    $('#rsReset', root).addEventListener('click', () => viewer.resetView());

    // ---- UNFC statement
    $('#rsUnfc', root).innerHTML = `<table class="tbl"><thead><tr><th>UNFC</th><th>Category</th><th class="num">Tonnes</th><th class="num">% Mn</th></tr></thead><tbody>
      ${UNFC_ORDER.map((c) => `<tr><td><span class="badge" style="background:${UNFC_COLORS[c]};color:#fff">${c}</span></td><td>${esc(cls[c].label)}</td><td class="num">${t(cls[c].tonnes)}</td><td class="num">${num(cls[c].grade, 1)}</td></tr>`).join('')}
      <tr><td></td><td><b>Total reserves</b></td><td class="num"><b>${t(S.reserves.tonnes)}</b></td><td class="num">${num(S.reserves.grade, 1)}</td></tr>
      <tr><td></td><td><b>Total resources</b></td><td class="num"><b>${t(S.resources.tonnes)}</b></td><td class="num">${num(S.resources.grade, 1)}</td></tr></tbody></table>
      <div class="note small" style="margin-top:10px">${esc(r.method_note)}</div>`;

    // ---- longitudinal section
    const lenses = r.frame.lenses.map((L) => L.id);
    let lens = 'A', lsMode = 'grade';
    $('#rsLens', root).innerHTML = lenses.map((l) => `<button data-l="${l}" class="${l === 'A' ? 'on' : ''}">${esc(r.frame.lenses.find((x) => x.id === l).name)}</button>`).join('');
    const sinDip = Math.sin((r.frame.dipDeg * Math.PI) / 180), halfH = (r.panel_m / 2) * sinDip;
    const drawLS = () => {
      const ps = r.panels.filter((p) => p.lens === lens), pier = r.pierce.filter((p) => p.lens === lens), props = r.proposals.filter((p) => p.lens === lens);
      const color = (p) => (p.unfc === 'Depleted' ? 'rgba(120,114,130,.35)' : lsMode === 'unfc' ? UNFC_COLORS[p.unfc] || '#999' : lsMode === 'T' ? `hsl(${259 - Math.min(1, p.T / 14) * 220},70%,50%)` : `#${gradeColor(p.grade).getHexString()}`);
      chart($('#rsLS', root), (pa) => ({
        legend: { data: ['Ore panels', 'Drill intercepts', 'Barren pierce points', 'Proposed infill holes'] },
        tooltip: { trigger: 'item', formatter: (d) => { if (d.seriesName === 'Ore panels') { const p = ps[d.dataIndex]; return `<b>Panel</b> u ${p.u} m · depth ${p.depth} m<br>Mn <b>${p.grade}%</b> · T <b>${p.T} m</b><br>${p.unfc} · ${p.confidence}<br>${t(p.tonnes)}`; }
          if (d.seriesName === 'Proposed infill holes') { const p = props[d.dataIndex]; return `<b>${p.id}</b><br>target depth ${p.target_depth_m} m<br>est. ${p.est_grade}% Mn × ${p.est_thickness} m<br>upgrades ${t(p.upgrade_tonnes)}`; }
          const p = d.data.raw; return `<b>${p.hole_id}</b> (${p.year}, ${esc(p.purpose)})<br>${p.true_m ? `${p.true_m} m @ <b>${p.grade}% Mn</b>` : 'no ore (pinch-out)'}<br>depth ${p.depth_m} m`; } },
        grid: { left: 10, right: 16, top: 34, bottom: 30, containLabel: true },
        xAxis: { type: 'value', name: 'metres along strike', nameLocation: 'middle', nameGap: 26, min: Math.min(...ps.map((p) => p.u)) - 40, max: Math.max(...ps.map((p) => p.u)) + 40 },
        yAxis: { type: 'value', name: 'depth below surface (m)', inverse: true, min: 0, nameLocation: 'middle', nameGap: 44 },
        series: [
          { name: 'Ore panels', type: 'custom', progressive: 0, itemStyle: { color: pa.brand }, data: ps.map((p) => [p.u, p.depth]),
            renderItem: (params, api2) => { const p = ps[params.dataIndex], a = api2.coord([p.u - r.panel_m / 2, p.depth - halfH]), b = api2.coord([p.u + r.panel_m / 2, p.depth + halfH]);
              return { type: 'rect', shape: { x: a[0], y: a[1], width: b[0] - a[0] + 0.5, height: b[1] - a[1] + 0.5 }, style: { fill: color(p) } }; },
            markLine: { silent: true, symbol: 'none', label: { position: 'insideStartTop', fontSize: 10, color: pa.text2 }, data: [
              { yAxis: r.frame.mined_to_m, lineStyle: { color: pa.muted, type: 'dashed' }, label: { formatter: `mined out above ${r.frame.mined_to_m} m` } },
              { yAxis: r.frame.plan_depth_m, lineStyle: { color: pa.rose, type: 'dashed' }, label: { formatter: `approved mining depth ${r.frame.plan_depth_m} m` } }] } },
          { name: 'Drill intercepts', type: 'scatter', symbolSize: 6, itemStyle: { color: '#fff', borderColor: '#111', borderWidth: 1.2 }, data: pier.filter((p) => p.true_m > 0).map((p) => ({ value: [p.u, p.depth_m], raw: p })) },
          { name: 'Barren pierce points', type: 'scatter', symbol: 'diamond', symbolSize: 7, itemStyle: { color: '#111', borderColor: '#fff', borderWidth: 1 }, data: pier.filter((p) => p.true_m === 0).map((p) => ({ value: [p.u, p.depth_m], raw: p })) },
          { name: 'Proposed infill holes', type: 'scatter', symbol: 'pin', symbolSize: 22, itemStyle: { color: '#ff3d7f' }, data: props.map((p) => [p.u, p.target_depth_m]) },
        ],
      }));
    };
    drawLS();
    $$('#rsLens button', root).forEach((b) => b.addEventListener('click', () => { $$('#rsLens button', root).forEach((x) => x.classList.toggle('on', x === b)); lens = b.dataset.l; drawLS(); }));
    $$('#rsLsMode button', root).forEach((b) => b.addEventListener('click', () => { $$('#rsLsMode button', root).forEach((x) => x.classList.toggle('on', x === b)); lsMode = b.dataset.m; drawLS(); }));

    // ---- grade-tonnage
    chart($('#rsGT', root), (p) => ({
      legend: { data: ['Tonnes above cut-off', 'Mean grade'] },
      tooltip: { trigger: 'axis', formatter: (it) => `cut-off ${it[0].name}% Mn<br>${t(it[0].value)} @ ${it[1]?.value ?? '—'}% Mn` },
      xAxis: { type: 'category', data: r.grade_tonnage.map((g) => g.cutoff), name: 'cut-off % Mn', nameLocation: 'middle', nameGap: 24 },
      yAxis: [{ type: 'value', axisLabel: { formatter: (v) => `${(v / 1e6).toFixed(0)} Mt` } }, { type: 'value', min: 30, max: 52, splitLine: { show: false }, axisLabel: { formatter: '{value}%' } }],
      series: [
        { name: 'Tonnes above cut-off', type: 'line', data: r.grade_tonnage.map((g) => g.tonnes), areaStyle: { color: p.band }, lineStyle: { color: p.brand, width: 2.5 }, symbol: 'none',
          markLine: { silent: true, symbol: 'none', data: [{ xAxis: String(r.cutoff_mn - (r.cutoff_mn % 2)) }], lineStyle: { color: p.rose, type: 'dashed' }, label: { formatter: 'reserve cut-off', color: p.rose, fontSize: 10 } } },
        { name: 'Mean grade', type: 'line', yAxisIndex: 1, data: r.grade_tonnage.map((g) => g.grade), lineStyle: { color: p.high, width: 2 }, symbol: 'none' },
      ],
    }));

    // ---- variogram
    const vg = r.variograms[0]?.thickness;
    if (vg) {
      const mdl = vg.model, sph = (h) => (h <= 0 ? 0 : h >= mdl.range ? mdl.nugget + mdl.sill : mdl.nugget + mdl.sill * (1.5 * (h / mdl.range) - 0.5 * (h / mdl.range) ** 3));
      const hs = Array.from({ length: 60 }, (_, i) => (i / 59) * 720);
      chart($('#rsVario', root), (p) => ({
        legend: { data: ['Experimental', 'Spherical model'] },
        tooltip: { trigger: 'item', formatter: (d) => (d.seriesName === 'Experimental' ? `lag ${d.value[0]} m<br>γ = ${d.value[1]}<br>${vg.experimental[d.dataIndex].pairs} pairs` : `h ${Math.round(d.value[0])} m · γ ${d.value[1].toFixed(2)}`) },
        xAxis: { type: 'value', name: 'lag (m)', nameLocation: 'middle', nameGap: 24, max: 720 },
        yAxis: { type: 'value', name: 'γ(h)' },
        series: [
          { name: 'Experimental', type: 'scatter', data: vg.experimental.map((e) => [e.h, e.gamma]), symbolSize: (v, d) => 5 + Math.sqrt(vg.experimental[d.dataIndex].pairs) / 4, itemStyle: { color: p.brand } },
          { name: 'Spherical model', type: 'line', data: hs.map((h) => [h, sph(h)]), symbol: 'none', lineStyle: { color: p.rose, width: 2 },
            markLine: { silent: true, symbol: 'none', data: [{ xAxis: mdl.range }], lineStyle: { color: p.faint, type: 'dashed' }, label: { formatter: `range ${mdl.range} m`, fontSize: 10, color: p.muted } } },
        ],
      }));
    }

    // ---- depletion
    const years = Math.min(60, Math.ceil(S.mine_life_years) + 5), y0 = new Date(r.as_of).getFullYear();
    chart($('#rsLife', root), (p) => ({
      legend: { data: ['Reserves (111+122)', '+ Measured/Indicated resources converted'] },
      tooltip: { trigger: 'axis', valueFormatter: (v) => t(v) },
      xAxis: { type: 'category', data: Array.from({ length: years }, (_, i) => y0 + i) },
      yAxis: { type: 'value', axisLabel: { formatter: (v) => `${(v / 1e6).toFixed(0)} Mt` } },
      series: [
        { name: 'Reserves (111+122)', type: 'line', areaStyle: { color: 'rgba(31,157,85,.15)' }, lineStyle: { color: '#1f9d55', width: 2.5 }, symbol: 'none', data: Array.from({ length: years }, (_, i) => Math.max(0, S.reserves.tonnes - i * m.annual_plan_t)) },
        { name: '+ Measured/Indicated resources converted', type: 'line', lineStyle: { color: p.info, type: 'dashed', width: 2 }, symbol: 'none', data: Array.from({ length: years }, (_, i) => Math.max(0, S.reserves.tonnes + cls['331'].tonnes + cls['332'].tonnes - i * m.annual_plan_t)) },
      ],
    }));

    // ---- proposals
    $('#rsProp', root).innerHTML = r.proposals.length ? `<table class="tbl"><thead><tr><th>Hole</th><th class="num">Target depth</th><th class="num">Est. grade × width</th><th class="num">Length</th><th class="num">Upgrades</th><th class="num">Cost</th><th>Collar</th></tr></thead><tbody>
      ${r.proposals.map((p) => `<tr><td class="nowrap"><b class="mono" style="color:#ff3d7f">${p.id}</b><div class="small muted">lode ${p.lens}</div></td><td class="num">${p.target_depth_m} m</td><td class="num">${p.est_grade}% × ${p.est_thickness} m</td><td class="num">${p.length_m} m</td><td class="num"><b>${t(p.upgrade_tonnes)}</b></td><td class="num">${inr(p.cost_lakh)}</td>
        <td class="mono small nowrap">${p.collar.lat.toFixed(5)}, ${p.collar.lng.toFixed(5)}<br><span class="muted">az ${p.azimuth}° dip ${p.dip}°</span></td></tr>`).join('')}</tbody></table>`
      : '<div class="loading-block">No Inferred ground within reach of the mining limit.</div>';

    // ---- hole log
    const holes = r.holes.filter((h) => h.assays.some((a) => a[2] >= 15)).sort((a, b) => a.id.localeCompare(b.id));
    $('#rsHole', root).innerHTML = holes.map((h) => `<option value="${h.id}">${h.id} · ${h.purpose} · ${h.depth_m} m</option>`).join('');
    const drawLog = async (id) => {
      const L = await api(`/boreholes/${id}`);
      if (!ctx.isCurrent()) return;
      const ivs = L.intervals, maxD = L.hole.depth_m;
      const assayed = ivs.filter((i) => i.mn_pct != null);
      const liths = [...new Set(ivs.map((i) => i.lith))];
      chart($('#rsLog', root), (p) => ({
        legend: { data: ['Mn %', 'Fe %', 'SiO₂ %'] },
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: (it) => { const iv = ivs.find((x) => it[0].axisValue >= x.from_m && it[0].axisValue < x.to_m); return iv ? `<b>${iv.from_m}–${iv.to_m} m</b><br>${esc(iv.lith)}${iv.mn_pct != null ? `<br>Mn ${iv.mn_pct}% · Fe ${iv.fe_pct}% · SiO₂ ${iv.sio2_pct}% · P ${iv.p_pct}%` : ''}` : ''; } },
        grid: [{ left: 10, width: 70, top: 34, bottom: 20, containLabel: false }, { left: 120, right: 16, top: 34, bottom: 20, containLabel: true }],
        xAxis: [{ gridIndex: 0, type: 'value', min: 0, max: 1, show: false }, { gridIndex: 1, type: 'value', min: 0, max: 60, position: 'top', axisLabel: { formatter: '{value}%' } }],
        yAxis: [{ gridIndex: 0, type: 'value', inverse: true, min: 0, max: maxD, axisLabel: { formatter: '{value} m' } }, { gridIndex: 1, type: 'value', inverse: true, min: 0, max: maxD, axisLabel: { show: false } }],
        series: [
          { type: 'custom', progressive: 0, xAxisIndex: 0, yAxisIndex: 0, data: ivs.map((i) => [0, i.from_m]), tooltip: { show: false },
            renderItem: (params, a) => { const iv = ivs[params.dataIndex], p0 = a.coord([0, iv.from_m]), p1 = a.coord([1, iv.to_m]); return { type: 'rect', shape: { x: p0[0], y: p0[1], width: p1[0] - p0[0], height: Math.max(1, p1[1] - p0[1]) }, style: { fill: LITH_COLORS[iv.lith] || '#999' } }; } },
          ...[['Mn %', 'mn_pct', p.brand], ['Fe %', 'fe_pct', p.high], ['SiO₂ %', 'sio2_pct', p.info]].map(([name, k, c]) => ({ name, type: 'line', xAxisIndex: 1, yAxisIndex: 1, symbol: 'none', step: 'end', lineStyle: { color: c, width: name === 'Mn %' ? 2.2 : 1.3 }, data: assayed.map((i) => [i[k], (i.from_m + i.to_m) / 2]),
            markArea: name === 'Mn %' ? { silent: true, itemStyle: { color: 'rgba(122,47,139,.10)' }, data: L.intercepts.filter((x) => x.from_m != null).map((x) => [{ yAxis: x.from_m, name: `${x.true_m} m @ ${x.grade}%` }, { yAxis: x.to_m }]), label: { color: p.brand, fontSize: 10, position: 'insideRight' } } : undefined })),
        ],
      }));
      $('#rsLog', root).title = liths.join(' · ');
    };
    $('#rsHole', root).addEventListener('change', (e) => drawLog(e.target.value));
    if (holes.length) drawLog(holes.find((h) => h.purpose === 'Development infill')?.id || holes[0].id).then(() => { $('#rsHole', root).value = holes.find((h) => h.purpose === 'Development infill')?.id || holes[0].id; });
  } catch (e) {
    root.insertAdjacentHTML('beforeend', errorBox(e));
  }
  return () => viewer?.dispose();
}

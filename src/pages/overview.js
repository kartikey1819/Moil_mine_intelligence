/* Command Center — portfolio status: reserves, production vs plan, forecast, shortfall risk, alerts, actions. */
import L from 'leaflet';
import { api } from '../lib/api.js';
import { fanChart } from '../lib/charts.js';
import { card, kpi, loading, errorBox, badge, src, $ } from '../lib/ui.js';
import { t, pct, esc, date, weekday, inr, signedT, ago } from '../lib/format.js';
import { state } from '../lib/store.js';

export async function mount(root, ctx) {
  root.innerHTML = `
    <div class="ph"><div><h2>Portfolio Command Center</h2>
      <p>Eight MOIL manganese mines in the Sausar belt (MP &amp; Maharashtra): reserves, production against plan, the probabilistic shortfall outlook and what to do about it — refreshed from live weather and the operating record.</p></div>
      <div class="actions" id="ovSrc"></div></div>
    <div class="grid g-6" id="ovKpis">${Array(6).fill('<div class="card skeleton" style="height:112px"></div>').join('')}</div>
    <div class="grid g-3-2">
      ${card({ title: 'Mine locations & shortfall risk', sub: 'next 4 weeks', right: '<span class="legend-row"><span><i style="background:var(--crit)"></i>High</span><span><i style="background:var(--med)"></i>Medium</span><span><i style="background:var(--low)"></i>Low</span></span>', body: '<div id="ovMap" class="map" style="height:390px"></div>', bodyCls: 'flush' })}
      ${card({ title: 'Portfolio production', sub: 'weekly · actual vs plan · 13-week forecast', right: src('ml', 'Monte-Carlo × ML'), body: '<div id="ovChart" class="chart lg"></div>' })}
    </div>
    ${card({ title: 'Mine performance & outlook', sub: 'click a row to drill down', right: `${src('sim', 'Ops: simulated')} ${src('real', 'Weather: ERA5 + live')}`, body: `<div class="tbl-wrap" id="ovTable">${loading('Running forecasts…', 'Monte-Carlo simulation of every mine')}</div>`, bodyCls: 'flush' })}
    <div class="grid g-3">
      ${card({ title: 'Early warnings', sub: 'highest impact first', right: '<a href="#/risk" class="btn sm">All alerts →</a>', body: `<div id="ovAlerts">${loading()}</div>`, bodyCls: 'flush' })}
      ${card({ title: 'Rain outlook · next 7 days', sub: 'mm/day per mine', right: src('live', 'Open-Meteo'), body: '<div id="ovWx"></div>' })}
      ${card({ title: 'Top corrective actions', sub: 'optimiser, highest-risk mines', right: '<a href="#/actions" class="btn sm">Planner →</a>', body: `<div id="ovActions">${loading('Optimising…', 'evaluating actions with the forecast model')}</div>` })}
    </div>`;

  let map;
  try {
    const [ov, hist] = await Promise.all([api('/overview'), api('/production?grain=week&days=240')]);
    if (!ctx.isCurrent()) return;
    const P = ov.portfolio, K = ov.kpis;
    $('#ovSrc', root).innerHTML = `${src(ov.weather_live ? 'live' : 'real', ov.weather_live ? `Weather live · ${ago(ov.weather_fetched_at)}` : 'Weather: climatology')} <span class="badge neutral">Data as of ${date(ov.as_of, { day: 'numeric', month: 'short', year: 'numeric' })}</span>`;

    // ---- KPIs
    const gap4 = P.next4.p50 - P.next4.plan;
    $('#ovKpis', root).innerHTML = [
      kpi({ label: 'Mn ore reserves', value: t(K.reserves_t, { unit: false, d: 1 }), unit: 'Mt', foot: `UNFC 111+122 · +${t(K.resources_t, { d: 1 })} resources` }),
      kpi({ label: `${ov.fy.label} to date`, value: t(K.fytd_actual, { unit: false, d: 0 }), unit: 'kt', bar: K.fytd_actual / K.fytd_plan, foot: `${pct(K.fytd_actual / K.fytd_plan, 1)} of ${t(K.fytd_plan)} plan` }),
      kpi({ label: 'Next 4 weeks · P50', value: t(P.next4.p50, { unit: false, d: 1 }), unit: 'kt', tone: gap4 < 0 ? 'high' : 'low', foot: `<span class="delta ${gap4 < 0 ? 'down' : 'up'}">${signedT(gap4)}</span> vs plan ${t(P.next4.plan)}` }),
      kpi({ label: 'Shortfall risk (>5%)', value: pct(P.next4.p_shortfall_5pct), tone: P.next4.p_shortfall_5pct >= 0.7 ? 'crit' : P.next4.p_shortfall_5pct >= 0.4 ? 'high' : 'low', foot: `${badge(P.next4.p_shortfall_5pct >= 0.7 ? 'High' : P.next4.p_shortfall_5pct >= 0.4 ? 'Medium' : 'Low')} expected gap ${t(P.next4.expected_shortfall)}` }),
      kpi({ label: `${ov.fy.label} outlook · P50`, value: t(P.fy.p50, { unit: false, d: 2 }), unit: 'Mt', tone: P.fy.p_meet < 0.5 ? 'high' : 'low', foot: `plan ${t(P.fy.plan)} · P(meet) ${pct(P.fy.p_meet)}` }),
      kpi({ label: 'Active alerts', value: K.alerts.total, tone: K.alerts.critical ? 'crit' : '', foot: `${badge('Critical', `${K.alerts.critical} critical`)} ${badge('High', `${K.alerts.high} high`)}` }),
    ].join('');

    // ---- map
    map = L.map($('#ovMap', root), { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([21.65, 79.75], 9);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Imagery © Esri, Maxar', maxZoom: 18 }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', { attribution: '© OSM © CARTO', maxZoom: 18, opacity: 0.9 }).addTo(map);
    const color = (r) => ({ High: '#d92d20', Medium: '#e0a000', Low: '#16a34a' }[r]);
    ov.mines.forEach((m) => {
      const mk = L.circleMarker([m.lat, m.lng], { radius: 7 + Math.sqrt(m.annual_plan_t / 1e4) * 1.6, color: '#fff', weight: 2, fillColor: color(m.risk), fillOpacity: 0.92 }).addTo(map);
      mk.bindTooltip(`<b>${esc(m.name)}</b> · ${m.method === 'OC' ? 'Open cast' : 'Underground'}<br>Next 4 wk P50 <b>${t(m.next4.p50)}</b> / plan ${t(m.next4.plan)}<br>Shortfall risk (&gt;5%) <b>${pct(m.next4.p_shortfall_5pct)}</b><br>Reserves ${t(m.reserves?.reserves_t)} · life ${m.reserves?.life_years ?? '—'} yr`, { className: 'tt', direction: 'top', offset: [0, -8] });
      mk.on('click', () => window.goMine(m.id, 'production'));
      L.marker([m.lat, m.lng], { icon: L.divIcon({ className: '', html: `<div style="transform:translate(14px,-8px);color:#fff;font-weight:700;font-size:11px;text-shadow:0 1px 3px #000;white-space:nowrap">${esc(m.name.replace(' Mine', ''))}</div>` }), interactive: false }).addTo(map);
    });
    map.fitBounds(L.latLngBounds(ov.mines.map((m) => [m.lat, m.lng])).pad(0.25));

    // ---- production chart
    const series = hist.series.slice(0, -1);   // drop the partial current week
    fanChart($('#ovChart', root), { hist: series, weeks: P.weeks.slice(0, 13) });

    // ---- table
    const sorted = [...ov.mines].sort((a, b) => b.next4.p_shortfall_5pct - a.next4.p_shortfall_5pct);
    $('#ovTable', root).innerHTML = `<table class="tbl"><thead><tr>
      <th>Mine</th><th>Method</th><th class="num">FYTD attain.</th><th class="num">Last 30 d</th><th class="num">Next 4 wk P50 / plan</th><th>Shortfall risk &gt;5%</th><th>Largest drag</th>
      <th class="num">Fleet avail.</th><th class="num">ROM cover</th><th class="num">Reserves · life</th><th class="c">Alerts</th></tr></thead><tbody>
      ${sorted.map((m) => `<tr class="clickable ${m.id === state.mine ? 'sel' : ''}" data-mine="${m.id}">
        <td><b>${esc(m.name)}</b><div class="small muted">${esc(m.district)}, ${esc(m.state)}</div></td>
        <td><span class="badge ${m.method === 'OC' ? 'info' : 'brand'}">${m.method === 'OC' ? 'Open cast' : 'Underground'}</span></td>
        <td class="num">${pct(m.fytd.attainment, 1)}</td>
        <td class="num" style="color:${m.last30.attainment < 0.9 ? 'var(--crit)' : m.last30.attainment < 0.95 ? 'var(--high)' : 'inherit'}">${pct(m.last30.attainment, 1)}</td>
        <td class="num">${t(m.next4.p50)} <span class="muted">/ ${t(m.next4.plan)}</span></td>
        <td><div class="row"><div class="mini-bar" style="width:70px"><i style="width:${m.next4.p_shortfall_5pct * 100}%;background:${m.risk === 'High' ? 'var(--crit)' : m.risk === 'Medium' ? 'var(--med)' : 'var(--low)'}"></i></div><b class="mono">${pct(m.next4.p_shortfall_5pct)}</b></div></td>
        <td class="nowrap">${m.top_drag && m.top_drag.tonnes < 0 ? `${esc(m.top_drag.group)} <span class="mono muted">${signedT(m.top_drag.tonnes)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num">${pct(m.last30.fleet_avail, 1)}</td>
        <td class="num" style="color:${m.rom_days < 2 ? 'var(--crit)' : 'inherit'}">${m.rom_days} d</td>
        <td class="num">${t(m.reserves?.reserves_t)} <span class="muted">· ${m.reserves?.life_years ?? '—'} yr</span></td>
        <td class="c">${m.alerts.critical ? badge('Critical', m.alerts.critical) : ''} ${m.alerts.high ? badge('High', m.alerts.high) : ''} ${!m.alerts.critical && !m.alerts.high ? `<span class="muted">${m.alerts.total}</span>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
    root.querySelectorAll('#ovTable tr[data-mine]').forEach((tr) => tr.addEventListener('click', () => window.goMine(tr.dataset.mine, 'production')));

    // ---- alerts
    $('#ovAlerts', root).innerHTML = ov.alerts.slice(0, 7).map((a) => `<div class="alert-item ${a.severity}"><div class="rail"></div>
      <div><h4>${esc(a.title)}</h4><div class="meta">${badge(a.severity)}<span>${esc(a.mine)}</span><span>${esc(a.category)}</span></div></div>
      <div class="impact">${a.impact_t ? t(a.impact_t) : '—'}<small>at risk</small></div></div>`).join('') || '<div class="loading-block">No active alerts</div>';

    // ---- weather heat table
    const days = ov.mines[0].weather7.slice(0, 6).map((d) => d.date);
    const cell = (mm) => { const a = Math.min(1, (mm || 0) / 60); return `background:rgba(37,99,235,${(0.06 + a * 0.8).toFixed(2)});color:${a > 0.5 ? '#fff' : 'inherit'}`; };
    $('#ovWx', root).innerHTML = days.length ? `<div class="tbl-wrap"><table class="tbl compact" style="font-size:11.5px"><thead><tr><th>Mine</th>${days.map((d) => `<th class="c">${weekday(d)}<br><span class="faint">${date(d)}</span></th>`).join('')}</tr></thead><tbody>
      ${ov.mines.map((m) => `<tr><td><b>${esc(m.name.replace(' Mine', ''))}</b></td>${m.weather7.slice(0, 6).map((d) => `<td class="c mono" style="${cell(d.rain_mm)};border-radius:4px" title="${d.rain_mm} mm · ${d.tmax_c} °C · P(rain) ${d.rain_prob ?? '—'}%">${d.rain_mm >= 1 ? Math.round(d.rain_mm) : '·'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div><div class="small muted" style="margin-top:8px">Cells ≥ 25 mm (open cast) / 45 mm (underground) raise blasting and flooding alerts.</div>` : '<div class="note">Live forecast unavailable — forecasts use ERA5 climatology.</div>';

    // ---- top actions from the two highest-risk mines (computed in the background on the server)
    const top = sorted.slice(0, 2);
    Promise.all(top.map((m) => api(`/mines/${m.id}/actions`, { ttl: 10 * 60e3 }).catch(() => null))).then((plans) => {
      if (!ctx.isCurrent()) return;
      const items = plans.filter(Boolean).flatMap((pl) => pl.actions.filter((a) => a.selected).slice(0, 3).map((a) => ({ ...a, mine: pl.mine, mine_id: pl.mine_id })));
      $('#ovActions', root).innerHTML = items.length ? `<div class="stack">${items.map((a) => `<div class="row between" style="align-items:flex-start;gap:12px;padding-bottom:9px;border-bottom:1px solid var(--border)">
        <div><div class="small muted">${esc(a.mine)} · ${esc(a.category)}</div><b style="font-size:12.5px">${esc(a.title)}</b></div>
        <div style="text-align:right;white-space:nowrap"><b class="mono" style="color:var(--low)">${signedT(a.net_t_13w)}</b><div class="small muted">${inr(a.cost_lakh)} · ROI ${a.roi ?? '—'}×</div></div></div>`).join('')}</div>` : '<div class="muted">No actions available.</div>';
    });
  } catch (e) {
    root.innerHTML += errorBox(e);
  }
  return () => { map?.remove(); };
}

/* MOIL Mine Intelligence — app bootstrap: shell, hash router, global mine context, theme. */
import 'leaflet/dist/leaflet.css';
import './styles/app.css';
import { api } from './lib/api.js';
import { state, set, subscribe } from './lib/store.js';
import { disposeCharts, rerenderCharts } from './lib/charts.js';
import { errorBox, loading, $, $$ } from './lib/ui.js';
import { ago, dateLong } from './lib/format.js';

const ROUTES = {
  overview: { title: 'Command Center', crumb: 'Portfolio view · all MOIL mines', load: () => import('./pages/overview.js'), portfolio: true },
  exploration: { title: 'Satellite Prospecting', crumb: 'Step 1 · Identify reserves — surface indicators from Earth observation', load: () => import('./pages/exploration.js') },
  reserves: { title: 'Subsurface & Reserves', crumb: 'Step 1 · Identify reserves — drilling, kriging & UNFC classification', load: () => import('./pages/reserves.js') },
  production: { title: 'Production Forecast', crumb: 'Step 2 · Predict shortfalls — Monte-Carlo × ML forecast', load: () => import('./pages/production.js') },
  risk: { title: 'Shortfall Risk & Alerts', crumb: 'Step 2 · Predict shortfalls — risk decomposition & early warnings', load: () => import('./pages/risk.js'), portfolio: true },
  actions: { title: 'Action Planner', crumb: 'Step 3 · Corrective action — optimised schedule, blasting & equipment plan', load: () => import('./pages/actions.js') },
  data: { title: 'Data & Models', crumb: 'Platform · data sources, lineage, model cards, retraining', load: () => import('./pages/data.js'), portfolio: true },
};

let cleanup = null, currentRoute = null, renderSeq = 0;

async function render() {
  const [route, param] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  const def = ROUTES[route] || ROUTES.overview;
  const name = ROUTES[route] ? route : 'overview';
  const seq = ++renderSeq;
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.warn(e); } }
  cleanup = null;
  disposeCharts();
  currentRoute = name;
  $$('#nav a[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#pageTitle').textContent = def.title;
  $('#pageCrumb').textContent = def.crumb;
  $('#mineSelectWrap').style.opacity = def.portfolio ? 0.55 : 1;
  $('#mineSelectWrap').title = def.portfolio ? 'Portfolio page — pick a mine to drill down' : 'Mine in focus';
  const root = $('#content');
  root.innerHTML = `<div class="page">${loading('Loading module…')}</div>`;
  root.scrollTop = 0;
  try {
    const mod = await def.load();
    if (seq !== renderSeq) return;
    const page = document.createElement('div');
    page.className = 'page';
    root.innerHTML = '';
    root.appendChild(page);
    cleanup = await mod.mount(page, { mine: state.mine, param, isCurrent: () => seq === renderSeq });
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) root.innerHTML = `<div class="page">${errorBox(e)}</div>`;
  }
}

async function boot() {
  // theme + chrome
  $('#btnTheme').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('moil-theme', theme); } catch { /* ignore */ }
    set({ theme });
    rerenderCharts();
  };
  $('#btnCollapse').onclick = () => { $('#shell').classList.toggle('collapsed'); setTimeout(() => window.dispatchEvent(new Event('resize')), 50); };
  $('#btnPrint').onclick = () => window.print();
  const tick = () => { $('#clock').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', hour12: false }); };
  tick(); setInterval(tick, 20e3);

  try {
    // the API may still be booting (the first run seeds the database): retry for up to ~3 minutes
    let meta;
    for (let i = 0; ; i++) {
      try { meta = await api('/meta', { ttl: 0 }); break; } catch (e) {
        if (i >= 90) throw e;
        $('#content').innerHTML = `<div class="page">${loading('Starting MOIL Mine Intelligence services…', 'The API server is booting — the first run builds the database and trains the model.')}</div>`;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    set({ meta });
    if (!meta.mines.some((m) => m.id === state.mine)) set({ mine: meta.mines[0].id });
    $('#mineSelect').innerHTML = meta.mines.map((m) => `<option value="${m.id}">${m.name} · ${m.method === 'OC' ? 'Open cast' : 'Underground'}</option>`).join('');
    $('#mineSelect').value = state.mine;
    $('#fyLabel').textContent = meta.fy.label;
    $('#asOf').textContent = dateLong(meta.as_of);
    $('#apiDot').className = 'dot ok'; $('#apiState').textContent = 'online';
  } catch (e) {
    $('#apiDot').className = 'dot bad'; $('#apiState').textContent = 'offline';
    $('#content').innerHTML = `<div class="page">${errorBox(new Error(`API server not reachable (${e.message}). Start it with "npm run dev".`))}</div>`;
    return;
  }
  $('#mineSelect').onchange = (e) => set({ mine: e.target.value });
  subscribe((patch) => {
    if ('mine' in patch) { $('#mineSelect').value = state.mine; if (!ROUTES[currentRoute]?.portfolio) render(); }
  });
  window.addEventListener('hashchange', render);
  render();
  pollStatus();
  setInterval(pollStatus, 5 * 60e3);
}

async function pollStatus() {
  try {
    const w = await api('/weather/live', { ttl: 0 });
    const ok = !!w.fetched_at && !w.error;
    $('#wxDot').className = `dot ${ok ? 'ok' : 'warn'}`;
    $('#wxState').textContent = ok ? `live · ${ago(w.fetched_at)}` : 'climatology fallback';
    $('#apiDot').className = 'dot ok'; $('#apiState').textContent = 'online';
  } catch {
    $('#apiDot').className = 'dot bad'; $('#apiState').textContent = 'offline';
  }
}

/** Navigate to a mine-specific page from anywhere (e.g. a table row). */
window.goMine = (id, route = 'production') => { set({ mine: id }); location.hash = `#/${route}`; };

boot();

/* MOIL Mine Intelligence — API server.
 *   npm run dev    → this server on :8710 + Vite on :5173 (proxying /api)
 *   npm start      → this server alone, also serving the built dashboard from dist/
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, get, ROOT } from './lib/db.mjs';
import { api } from './routes.mjs';
import { rollForward } from './services/ingest.mjs';
import { portfolioForecast, clearForecastCache } from './services/forecast.mjs';
import { actionPlan } from './services/optimizer.mjs';
import { resources } from './services/reserves.mjs';
import { liveForecast } from './services/weather.mjs';
import { MINES } from './config/mines.mjs';

const PORT = +(process.env.PORT || 8710);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

openDb();
if (!get('SELECT COUNT(*) n FROM daily_ops')?.n) {
  log('[boot] empty database — running first-time seed (downloads ERA5 weather + DEM, ~1–2 min)…');
  const { seed } = await import('./seed/index.mjs');
  await seed({ log });
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use('/api', (req, res, next) => { const t0 = performance.now(); res.on('finish', () => { const ms = performance.now() - t0; if (ms > 800) log(`[slow] ${req.method} ${req.originalUrl} ${Math.round(ms)} ms`); }); next(); });
app.use('/api', api);
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.listen(PORT, () => log(`[boot] API ready on http://localhost:${PORT}/api  (${fs.existsSync(dist) ? 'serving dist/' : 'dev mode — UI via Vite'})`));

// ---- background: live ingest + cache warm-up -----------------------------------------------------------
let warming = false;
async function refresh(reason) {
  if (warming) return;
  warming = true;
  const t0 = Date.now();
  try {
    await rollForward({ log });
    clearForecastCache();
    await liveForecast({ maxAgeMs: 0 });
    await Promise.all([portfolioForecast(), ...MINES.map((m) => resources(m.id))]);
    log(`[warm] forecasts + reserves ready (${reason}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    for (const m of MINES) await actionPlan(m.id);
    log(`[warm] action plans ready (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { log('[warm] failed:', e.message); }
  finally { warming = false; }
}
setTimeout(() => refresh('startup'), 500);
setInterval(() => refresh('scheduled'), 3600e3);   // hourly: new weather forecast, any new operating day, re-warm

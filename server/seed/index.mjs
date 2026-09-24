/* Seed pipeline: builds data/moil.db from scratch.
 *   1. mines + equipment register
 *   2. REAL weather: ERA5-Land daily 2015→today for every mine (+ recent days from the forecast analysis)
 *   3. REAL terrain: Copernicus DEM grid around every lease
 *   4. SIMULATED operating history 2023-04-01 → yesterday, driven by the real weather
 *   5. SIMULATED drilling database (collars on the real DEM, logs, assays)
 *   6. train + register the production-attainment model
 * Run: npm run seed   (raw downloads are cached in data/raw, so re-seeding works offline) */
import fs from 'node:fs';
import { openDb, closeDb, insertMany, setMeta, DB_PATH, all } from '../lib/db.mjs';
import { MINES } from '../config/mines.mjs';
import { addDays, todayIST } from '../lib/dates.mjs';
import { loadHistory, fillRecent, weatherMap } from '../services/weather.mjs';
import { fetchDemGrid, saveDem, demSampler } from '../services/terrain.mjs';
import { buildFleet, restoreState, serializeState, simulateOperations } from './operations.mjs';
import { generateDrilling } from './drilling.mjs';
import { saveUnitState } from '../services/ingest.mjs';
import { trainProductionModel } from '../ml/production-model.mjs';

export const HISTORY_START = '2023-04-01';
const WARMUP_START = '2023-01-01';

export async function seed({ log = console.log } = {}) {
  const t0 = Date.now();
  closeDb();                                   // release the file before replacing it
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
  openDb();

  insertMany('mines', MINES.map((m) => ({ id: m.id, name: m.name, district: m.district, state: m.state, lat: m.lat, lng: m.lng, method: m.method,
    method_label: m.methodLabel, annual_plan_t: m.annualPlanT, grade_mn: m.gradeMn, shifts: m.shifts, config_json: JSON.stringify(m) })));

  log('[seed] weather: ERA5-Land archive (Open-Meteo)…');
  const hist = await loadHistory('2015-01-01');
  log(`[seed]   ${hist.start} → ${hist.end} for ${MINES.length} mines`);
  try { await fillRecent(); log('[seed]   recent days filled from forecast-model analysis'); } catch (e) { log(`[seed]   recent fill skipped: ${e.message}`); }

  log('[seed] terrain: Copernicus DEM grids…');
  const dems = {};
  for (const m of MINES) { const g = await fetchDemGrid(m); saveDem(m.id, g); dems[m.id] = demSampler(g); }

  const end = addDays(todayIST(), -1);
  for (const m of MINES) {
    const fleet = buildFleet(m);
    insertMany('equipment', fleet);
    const state = restoreState(m, fleet, null);
    const wx = weatherMap(m.id, '2022-11-01');
    simulateOperations(m, state, wx, WARMUP_START, addDays(HISTORY_START, -1), { record: false });
    const { daily, events, blasts } = simulateOperations(m, state, wx, HISTORY_START, end);
    insertMany('daily_ops', daily);
    insertMany('equipment_events', events);
    insertMany('blast_log', blasts);
    setMeta(`simstate:${m.id}`, serializeState(state));
    saveUnitState(state);

    const { holes, intervals } = generateDrilling(m, dems[m.id]);
    insertMany('boreholes', holes);
    insertMany('borehole_intervals', intervals);
    const att = daily.reduce((s, r) => s + r.actual_t, 0) / daily.reduce((s, r) => s + r.plan_t, 0);
    log(`[seed] ${m.name.padEnd(20)} ${daily.length} days (attainment ${(att * 100).toFixed(1)}%) · ${fleet.length} units · ${events.length} maint. events · ${holes.length} holes / ${intervals.length} intervals`);
  }

  log('[seed] training production-attainment model…');
  trainProductionModel({ log });
  setMeta('seeded_at', new Date().toISOString());
  setMeta('history_start', HISTORY_START);
  setMeta('seed_version', '1');
  log(`[seed] done in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${DB_PATH}`);
  return all('SELECT COUNT(*) n FROM daily_ops')[0].n;
}

if (process.argv[1] && import.meta.filename === (await import('node:path')).resolve(process.argv[1])) {
  seed().catch((e) => { console.error(e); process.exit(1); });
}

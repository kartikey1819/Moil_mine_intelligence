/* Live roll-forward: keeps the operating record current. On start-up and every few hours it pulls the
 * newest real weather, then appends the missing operating days for every mine (simulated ops — in
 * production this is where MOIL's shift reports / SCADA feed would be ingested instead). */
import { all, get, insertMany, run, getMeta, setMeta } from '../lib/db.mjs';
import { addDays, todayIST } from '../lib/dates.mjs';
import { MINES } from '../config/mines.mjs';
import { fillRecent, loadHistory, weatherMap } from './weather.mjs';
import { restoreState, serializeState, simulateOperations } from '../seed/operations.mjs';

export function saveUnitState(state) {
  const stmt = 'UPDATE equipment SET hours_since_pm = ?, down_h_remaining = ?, total_op_h = ?, status = ? WHERE id = ?';
  for (const u of state.units) run(stmt, +u.hsp.toFixed(1), +u.down.toFixed(1), +u.op.toFixed(0), u.down > 0 ? 'Under repair' : 'Operating', u.id);
}

export function loadMineState(mine) {
  const eq = all('SELECT * FROM equipment WHERE mine_id = ? ORDER BY id', mine.id);
  return restoreState(mine, eq, getMeta(`simstate:${mine.id}`));
}

export async function rollForward({ log = console.log, refreshWeather = true } = {}) {
  if (refreshWeather) {
    try { await loadHistory(); } catch (e) { log(`[ingest] ERA5 refresh skipped: ${e.message}`); }
    try { await fillRecent(); } catch (e) { log(`[ingest] recent weather skipped: ${e.message}`); }
  }
  const yesterday = addDays(todayIST(), -1);
  let added = 0;
  for (const mine of MINES) {
    const last = get('SELECT MAX(date) d FROM daily_ops WHERE mine_id = ?', mine.id)?.d;
    if (!last || last >= yesterday) continue;
    const state = loadMineState(mine);
    const wx = weatherMap(mine.id, addDays(last, -40));
    const { daily, events, blasts } = simulateOperations(mine, state, wx, addDays(last, 1), yesterday);
    if (!daily.length) continue;
    insertMany('daily_ops', daily, { replace: true });
    insertMany('equipment_events', events);
    insertMany('blast_log', blasts);
    setMeta(`simstate:${mine.id}`, serializeState(state));
    saveUnitState(state);
    added += daily.length;
  }
  setMeta('last_ingest_at', new Date().toISOString());
  if (added) log(`[ingest] appended ${added} mine-days of operating data`);
  return added;
}

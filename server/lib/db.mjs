/* Data layer: one SQLite database (Node's built-in node:sqlite, no native build step).
 *
 *   mines, equipment, equipment_events     asset register + maintenance / breakdown log
 *   daily_ops, blast_log                   production, dispatch, stock, drivers, blasting
 *   weather_daily                          ERA5-Land reanalysis per mine (real, Open-Meteo)
 *   boreholes, borehole_intervals          drilling database (collars, surveys, assays)
 *   dem_grid                               Copernicus DEM elevation grid per mine lease (real)
 *   model_registry, meta, imports          ML model versions, pipeline state, upload audit
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = process.env.MOIL_DB || path.join(DATA_DIR, 'moil.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS mines (
  id TEXT PRIMARY KEY, name TEXT, district TEXT, state TEXT, lat REAL, lng REAL, method TEXT, method_label TEXT,
  annual_plan_t REAL, grade_mn REAL, shifts INTEGER, config_json TEXT);
CREATE TABLE IF NOT EXISTS weather_daily (
  mine_id TEXT, date TEXT, rain_mm REAL, tmax_c REAL, soil_moisture REAL, soil_temp_c REAL, et0_mm REAL, source TEXT,
  PRIMARY KEY (mine_id, date));
CREATE TABLE IF NOT EXISTS equipment (
  id TEXT PRIMARY KEY, mine_id TEXT, class TEXT, label TEXT, grp TEXT, commissioned INTEGER, mtbf_h REAL, mttr_h REAL, beta REAL,
  pm_interval_h REAL, critical INTEGER, hours_since_pm REAL, down_h_remaining REAL, total_op_h REAL, status TEXT);
CREATE TABLE IF NOT EXISTS equipment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, equipment_id TEXT, mine_id TEXT, date TEXT, kind TEXT, hours REAL, cause TEXT);
CREATE INDEX IF NOT EXISTS ix_eqev ON equipment_events (mine_id, date);
CREATE TABLE IF NOT EXISTS daily_ops (
  mine_id TEXT, date TEXT, plan_t REAL, target_t REAL, actual_t REAL, dispatch_t REAL, rom_stock_t REAL, broken_stock_t REAL, grade_mn REAL,
  fleet_avail REAL, avail_loading REAL, avail_haulage REAL, avail_hoisting REAL, avail_drilling REAL, avail_crushing REAL, avail_pumping REAL,
  crit_down_h REAL, unplanned_down_h REAL, pm_h REAL, blasts_planned INTEGER, blasts_done INTEGER, blast_delay_h REAL, poor_frag INTEGER,
  rain_mm REAL, soil_moisture REAL, tmax_c REAL, soil_temp_c REAL, inflow_m3h REAL, pump_cap_m3h REAL, water_store_m3 REAL, flood_loss REAL,
  shift_hours REAL, outage_h REAL, bottleneck TEXT, source TEXT, PRIMARY KEY (mine_id, date));
CREATE TABLE IF NOT EXISTS blast_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mine_id TEXT, date TEXT, planned INTEGER, executed INTEGER, delay_h REAL, reason TEXT, fragmentation TEXT);
CREATE INDEX IF NOT EXISTS ix_blast ON blast_log (mine_id, date);
CREATE TABLE IF NOT EXISTS boreholes (
  id TEXT PRIMARY KEY, mine_id TEXT, collar_e REAL, collar_n REAL, collar_z REAL, lat REAL, lng REAL, azimuth REAL, dip REAL,
  depth_m REAL, drilled_on TEXT, purpose TEXT);
CREATE TABLE IF NOT EXISTS borehole_intervals (
  hole_id TEXT, from_m REAL, to_m REAL, lith TEXT, mn_pct REAL, fe_pct REAL, sio2_pct REAL, p_pct REAL);
CREATE INDEX IF NOT EXISTS ix_bhi ON borehole_intervals (hole_id);
CREATE TABLE IF NOT EXISTS dem_grid (mine_id TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS model_registry (name TEXT, version TEXT, trained_at TEXT, metrics_json TEXT, path TEXT, active INTEGER,
  PRIMARY KEY (name, version));
CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, filename TEXT, rows INTEGER, detail TEXT);
`;

let db;
export function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export const all = (sql, ...p) => openDb().prepare(sql).all(...p);
export const get = (sql, ...p) => openDb().prepare(sql).get(...p);
export const run = (sql, ...p) => openDb().prepare(sql).run(...p);

export function tx(fn) {
  const d = openDb();
  d.exec('BEGIN');
  try { const r = fn(d); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

/** Bulk insert rows (array of objects) into a table using the keys of the first row. */
export function insertMany(table, rows, { replace = false } = {}) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const stmt = openDb().prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => ':' + c).join(',')})`);
  tx(() => { for (const r of rows) stmt.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))); });
  return rows.length;
}

export const getMeta = (k) => get('SELECT value FROM meta WHERE key = ?', k)?.value ?? null;
export const setMeta = (k, v) => run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', k, String(v));

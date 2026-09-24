/* Weather & land-surface connector (real data, Open-Meteo, no API key).
 *
 *   ERA5 / ERA5-Land reanalysis  archive-api.open-meteo.com   rainfall, soil moisture 0–7 cm, 2 m Tmax, soil (land) temperature
 *   ECMWF/GFS/ICON best-match   api.open-meteo.com/forecast   16-day forecast + last 10 days (reanalysis lags ~5 days)
 *
 * All 8 mines are fetched in one multi-location request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchJSON } from '../lib/http.mjs';
import { DATA_DIR, all, insertMany, setMeta } from '../lib/db.mjs';
import { addDays, todayIST } from '../lib/dates.mjs';
import { MINES } from '../config/mines.mjs';

const RAW_DIR = path.join(DATA_DIR, 'raw');
const r1 = (v, d = 2) => (v == null ? null : +(+v).toFixed(d));
const coords = (mines) => `latitude=${mines.map((m) => m.lat).join(',')}&longitude=${mines.map((m) => m.lng).join(',')}`;

export async function fetchArchive(mines, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?${coords(mines)}&start_date=${start}&end_date=${end}` +
    '&daily=precipitation_sum,temperature_2m_max,soil_moisture_0_to_7cm_mean,soil_temperature_0_to_7cm_mean,et0_fao_evapotranspiration&timezone=Asia%2FKolkata';
  const res = await fetchJSON(url, { timeoutMs: 90000, retries: 3 });
  const arr = Array.isArray(res) ? res : [res];
  return Object.fromEntries(mines.map((m, k) => {
    const dly = arr[k].daily;
    return [m.id, dly.time.map((date, i) => ({
      date, rain_mm: r1(dly.precipitation_sum[i] ?? 0, 1), tmax_c: r1(dly.temperature_2m_max[i], 1), soil_moisture: r1(dly.soil_moisture_0_to_7cm_mean[i], 3),
      soil_temp_c: r1(dly.soil_temperature_0_to_7cm_mean[i], 1), et0_mm: r1(dly.et0_fao_evapotranspiration[i], 2), source: 'ERA5-Land reanalysis',
    })).filter((r) => r.tmax_c != null && r.soil_moisture != null)];
  }));
}

/** Forecast API: last `pastDays` days + next 16 days. Soil moisture / temperature are hourly layers averaged to days. */
export async function fetchForecastRaw(mines, pastDays = 10) {
  const url = `https://api.open-meteo.com/v1/forecast?${coords(mines)}&past_days=${pastDays}&forecast_days=16` +
    '&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,et0_fao_evapotranspiration' +
    '&hourly=soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_temperature_6cm&timezone=Asia%2FKolkata';
  const res = await fetchJSON(url, { timeoutMs: 45000, retries: 2 });
  const arr = Array.isArray(res) ? res : [res];
  return Object.fromEntries(mines.map((m, k) => {
    const { daily: dly, hourly: hr } = arr[k];
    const byDay = {};
    hr.time.forEach((t, i) => {
      const day = t.slice(0, 10), sm = [hr.soil_moisture_0_to_1cm[i], hr.soil_moisture_1_to_3cm[i], hr.soil_moisture_3_to_9cm[i]];
      if (sm.some((v) => v == null)) return;
      const b = (byDay[day] ||= { sm: 0, st: 0, n: 0 });
      b.sm += (sm[0] * 1 + sm[1] * 2 + sm[2] * 4) / 7; b.st += hr.soil_temperature_6cm[i] ?? 0; b.n++;
    });
    return [m.id, dly.time.map((date, i) => ({
      date, rain_mm: r1(dly.precipitation_sum[i] ?? 0, 1), rain_prob: dly.precipitation_probability_max?.[i] ?? null,
      tmax_c: r1(dly.temperature_2m_max[i], 1), tmin_c: r1(dly.temperature_2m_min[i], 1), wind_kmh: r1(dly.wind_speed_10m_max?.[i], 1),
      et0_mm: r1(dly.et0_fao_evapotranspiration?.[i], 2),
      soil_moisture: byDay[date]?.n ? r1(byDay[date].sm / byDay[date].n, 3) : null, soil_temp_c: byDay[date]?.n ? r1(byDay[date].st / byDay[date].n, 1) : null,
    }))];
  }));
}

/** Seed / refresh: archive into weather_daily (cached on disk so re-seeding works offline). */
export async function loadHistory(start = '2015-01-01') {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const cacheFile = path.join(RAW_DIR, 'era5_history.json');
  let cached = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
  const end = addDays(todayIST(), -6);
  if (!cached || cached.start !== start) {
    const data = await fetchArchive(MINES, start, end);
    cached = { start, end, fetched_at: new Date().toISOString(), data };
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
  } else if (cached.end < end) {
    try {
      const inc = await fetchArchive(MINES, addDays(cached.end, 1), end);
      for (const m of MINES) cached.data[m.id].push(...inc[m.id].filter((r) => r.date > cached.end));
      cached.end = end; cached.fetched_at = new Date().toISOString();
      fs.writeFileSync(cacheFile, JSON.stringify(cached));
    } catch (e) { console.warn('[weather] archive increment failed, using cache:', e.message); }
  }
  for (const m of MINES) insertMany('weather_daily', cached.data[m.id].map((r) => ({ mine_id: m.id, ...r })), { replace: true });
  return cached;
}

/** Fill the reanalysis gap (last ~6 days) from the forecast model's analysed past days. */
export async function fillRecent() {
  const fc = await fetchForecastRaw(MINES, 10);
  const today = todayIST();
  for (const m of MINES) {
    const have = new Set(all('SELECT date FROM weather_daily WHERE mine_id = ? AND date >= ?', m.id, addDays(today, -12)).map((r) => r.date));
    const rows = fc[m.id].filter((r) => r.date < today && !have.has(r.date) && r.soil_moisture != null)
      .map((r) => ({ mine_id: m.id, date: r.date, rain_mm: r.rain_mm, tmax_c: r.tmax_c, soil_moisture: r.soil_moisture, soil_temp_c: r.soil_temp_c, et0_mm: r.et0_mm, source: 'Forecast-model analysis (pending ERA5)' }));
    insertMany('weather_daily', rows, { replace: true });
  }
  setMeta('weather_recent_at', new Date().toISOString());
  return fc;
}

// ---- live forecast service (cached) ----------------------------------------------------------
let live = { at: 0, data: null, error: null };
export async function liveForecast({ maxAgeMs = 3 * 3600e3 } = {}) {   // the server refreshes it hourly in the background
  if (live.data && Date.now() - live.at < maxAgeMs) return live;
  try {
    const data = await fetchForecastRaw(MINES, 3);
    live = { at: Date.now(), data, error: null, fetched_at: new Date().toISOString() };
  } catch (e) {
    live = { ...live, error: String(e.message || e) };
  }
  return live;
}

/** Daily weather history for a mine as a date-indexed map (for driver simulation). */
export function weatherMap(mineId, from = '2015-01-01') {
  return new Map(all('SELECT date, rain_mm, tmax_c, soil_moisture, soil_temp_c FROM weather_daily WHERE mine_id = ? AND date >= ? ORDER BY date', mineId, from).map((r) => [r.date, r]));
}

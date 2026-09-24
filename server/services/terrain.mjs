/* Copernicus DEM (90 m, via Open-Meteo elevation API) sampled on a local grid around each mine lease.
 * Local coordinates: metres east (E) / north (N) of the mine reference point, Z = elevation (m RL). */
import fs from 'node:fs';
import path from 'node:path';
import { fetchJSON } from '../lib/http.mjs';
import { DATA_DIR, get, run } from '../lib/db.mjs';

export const KM = 111.32;
export const toLocal = (mine, lat, lng) => ({ e: (lng - mine.lng) * KM * 1000 * Math.cos((mine.lat * Math.PI) / 180), n: (lat - mine.lat) * KM * 1000 });
export const toLatLng = (mine, e, n) => ({ lat: mine.lat + n / (KM * 1000), lng: mine.lng + e / (KM * 1000 * Math.cos((mine.lat * Math.PI) / 180)) });

export const DEM_HALF_M = 1900, DEM_N = 28;

export async function fetchDemGrid(mine) {
  const cacheFile = path.join(DATA_DIR, 'raw', `dem_${mine.id}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const pts = [];
  for (let r = 0; r < DEM_N; r++) for (let c = 0; c < DEM_N; c++) {
    const e = -DEM_HALF_M + (c / (DEM_N - 1)) * 2 * DEM_HALF_M, n = DEM_HALF_M - (r / (DEM_N - 1)) * 2 * DEM_HALF_M;
    pts.push(toLatLng(mine, e, n));
  }
  const sources = [
    { name: 'Copernicus DEM GLO-90 (Open-Meteo elevation API)', batch: 100, wait: 1500,
      get: async (part) => (await fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${part.map((p) => p.lat.toFixed(5)).join(',')}&longitude=${part.map((p) => p.lng.toFixed(5)).join(',')}`, { retries: 1 })).elevation },
    { name: 'SRTM 90 m (OpenTopoData)', batch: 100, wait: 1100,
      get: async (part) => (await fetchJSON(`https://api.opentopodata.org/v1/srtm90m?locations=${part.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')}`, { retries: 2 })).results.map((x) => x.elevation) },
  ];
  let grid = null, lastErr;
  for (const src of sources) {
    try {
      const z = [];
      for (let i = 0; i < pts.length; i += src.batch) {
        z.push(...(await src.get(pts.slice(i, i + src.batch))));
        await new Promise((r) => setTimeout(r, src.wait));
      }
      grid = { n: DEM_N, half_m: DEM_HALF_M, source: src.name, fetched_at: new Date().toISOString(), z };
      break;
    } catch (e) { lastErr = e; console.warn(`[terrain] ${mine.id}: ${src.name} failed (${String(e.message).slice(0, 80)}), trying next source`); }
  }
  if (!grid) throw lastErr;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(grid));
  return grid;
}

export function saveDem(mineId, grid) { run('INSERT OR REPLACE INTO dem_grid (mine_id, json) VALUES (?, ?)', mineId, JSON.stringify(grid)); }
export function loadDem(mineId) { const r = get('SELECT json FROM dem_grid WHERE mine_id = ?', mineId); return r ? JSON.parse(r.json) : null; }

/** Bilinear elevation lookup in local coordinates. */
export function demSampler(grid) {
  const { n, half_m: H, z } = grid, step = (2 * H) / (n - 1);
  return (e, nn) => {
    const c = Math.min(n - 1.001, Math.max(0, (e + H) / step)), r = Math.min(n - 1.001, Math.max(0, (H - nn) / step));
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0;
    const at = (rr, cc) => z[rr * n + cc];
    return at(r0, c0) * (1 - fc) * (1 - fr) + at(r0, c0 + 1) * fc * (1 - fr) + at(r0 + 1, c0) * (1 - fc) * fr + at(r0 + 1, c0 + 1) * fc * fr;
  };
}

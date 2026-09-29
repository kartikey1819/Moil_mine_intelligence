/* API client: JSON fetch with short client-side cache and in-flight de-duplication.
 *
 * Snapshot mode (VITE_SNAPSHOT=1, used for the static Vercel deployment): GET requests read the
 * JSON files that scripts/export-snapshot.mjs saved at build time; requests that compute something
 * new (POST: what-if simulation, retraining, CSV import) need the live server and are refused. */
export const SNAPSHOT = import.meta.env.VITE_SNAPSHOT === '1';
export const SNAPSHOT_MSG = 'This is the static snapshot of the platform. Interactive simulation, retraining and data import run on the full (server) version.';

/** Keep in sync with snapshotFile() in scripts/export-snapshot.mjs */
export const snapshotFile = (path) => `${path.replace(/^\//, '').replace(/[/?&=]/g, '_')}.json`;

const cache = new Map();
const inflight = new Map();

export async function api(path, { ttl = 60e3, method = 'GET', body, headers } = {}) {
  if (SNAPSHOT && method !== 'GET') throw Object.assign(new Error(SNAPSHOT_MSG), { snapshot: true });
  const key = method === 'GET' ? path : null;
  if (key) {
    const hit = cache.get(key);
    if (hit && (SNAPSHOT || Date.now() - hit.at < ttl)) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
  }
  const p = (async () => {
    const url = SNAPSHOT ? `/snapshot/${snapshotFile(path)}` : `/api${path}`;
    const r = await fetch(url, SNAPSHOT ? {} : { method, body, headers: body && typeof body === 'string' && !headers ? { 'Content-Type': 'application/json' } : headers });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error(SNAPSHOT ? `Not included in this snapshot: ${path}` : `Bad response from ${path}`); }
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    if (key) cache.set(key, { at: Date.now(), value: data });
    return data;
  })();
  if (key) { inflight.set(key, p); p.then(() => inflight.delete(key), () => inflight.delete(key)); }
  return p;
}

export const post = (path, obj) => api(path, { method: 'POST', body: JSON.stringify(obj) });
export const clearApiCache = () => cache.clear();

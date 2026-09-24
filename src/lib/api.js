/* API client: JSON fetch with short client-side cache and in-flight de-duplication. */
const cache = new Map();
const inflight = new Map();

export async function api(path, { ttl = 60e3, method = 'GET', body, headers } = {}) {
  const key = method === 'GET' ? path : null;
  if (key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
  }
  const p = (async () => {
    const r = await fetch(`/api${path}`, { method, body, headers: body && typeof body === 'string' && !headers ? { 'Content-Type': 'application/json' } : headers });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`Bad response from ${path}`); }
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    if (key) cache.set(key, { at: Date.now(), value: data });
    return data;
  })();
  if (key) { inflight.set(key, p); p.then(() => inflight.delete(key), () => inflight.delete(key)); }
  return p;
}

export const post = (path, obj) => api(path, { method: 'POST', body: JSON.stringify(obj) });
export const clearApiCache = () => cache.clear();

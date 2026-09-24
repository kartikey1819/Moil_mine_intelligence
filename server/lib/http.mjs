/* Outbound HTTP for the live data connectors: timeout, retry, and a small in-memory TTL cache. */

const cache = new Map();

export async function fetchJSON(url, { timeoutMs = 30000, retries = 2, ttlMs = 0, init = {} } = {}) {
  if (ttlMs) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal, headers: { 'User-Agent': 'MOIL-Mine-Intelligence/1.0', ...(init.headers || {}) } });
      if (r.status === 429) {                            // free-tier rate limit: wait out a minute window, fail fast on hourly/daily
        const body = await r.text();
        if (attempt < retries && /minute/i.test(body)) { clearTimeout(t); await new Promise((res) => setTimeout(res, 61000)); continue; }
        throw Object.assign(new Error(`HTTP 429 ${body.slice(0, 160)}`), { fatal: true });
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      const value = await r.json();
      if (ttlMs) cache.set(url, { at: Date.now(), value });
      return value;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

/** Probe an endpoint for the data-source health panel. */
export async function probe(url, timeoutMs = 8000) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'MOIL-Mine-Intelligence/1.0' } });
    return { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

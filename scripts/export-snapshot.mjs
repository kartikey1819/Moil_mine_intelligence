/* Static snapshot export (for the Vercel deployment).
 *
 * Starts the API server, requests every endpoint the dashboard reads, and writes each response to
 * dist/snapshot/<file>.json. The snapshot build of the dashboard (VITE_SNAPSHOT=1) reads these files
 * instead of calling /api, so the whole platform runs as static files — instant, never sleeps.
 * The Satellite Prospecting page stays fully live (it calls the public satellite APIs from the browser).
 *
 * Run: npm run build:snapshot     (= vite build --mode snapshot && this script)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'snapshot');
const PORT = +(process.env.SNAPSHOT_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}/api`;

/** Keep in sync with snapshotFile() in src/lib/api.js */
const snapshotFile = (p) => `${p.replace(/^\//, '').replace(/[/?&=]/g, '_')}.json`;
const log = (...a) => console.log('[snapshot]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('[snapshot] dist/ not found — run "vite build --mode snapshot" first (npm run build:snapshot does both).');
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

log(`starting API server on :${PORT} (first run seeds the database, ~1 min)…`);
const server = spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
// The server rolls the operating record forward and warms its caches right after it starts;
// export only once that has finished, so every file comes from the same, current data.
let resolveWarm;
const warmed = new Promise((r) => { resolveWarm = r; });
server.stdout.on('data', (d) => {
  process.stdout.write(`  [api] ${d}`);
  if (/\[warm\] (forecasts \+ reserves ready|failed)/.test(String(d))) resolveWarm();
});
server.stderr.on('data', (d) => process.stderr.write(`  [api] ${d}`));
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);

async function get(p, attempt = 0) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10 * 60e3);
  try {
    const r = await fetch(BASE + p, { signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return text;
  } catch (e) {
    if (attempt < 2) { await sleep(3000); return get(p, attempt + 1); }
    throw new Error(`${p}: ${e.message}`);
  } finally { clearTimeout(t); }
}
let bytes = 0, files = 0;
async function save(p) {
  const body = await get(p);
  fs.writeFileSync(path.join(OUT, snapshotFile(p)), body);
  bytes += body.length; files++;
  return JSON.parse(body);
}
async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); }));
}

try {
  for (let i = 0; ; i++) {                                   // wait for the server (and a first-run seed)
    try { await get('/health'); break; } catch { if (i > 200) throw new Error('API server did not start'); await sleep(2000); }
  }
  log('waiting for live ingest + cache warm-up…');
  await Promise.race([warmed, sleep(15 * 60e3)]);
  const meta = await save('/meta');
  const mines = meta.mines.map((m) => m.id);
  log(`API up · data as of ${meta.as_of} · ${mines.length} mines`);

  // portfolio + per-mine pages (the heavy ones first so the worker pool stays busy)
  await save('/overview');
  await pool(['/production?grain=week&days=240', '/weather/live', '/risk', '/alerts', '/models', '/sources'], 3, save);
  for (const id of mines) {
    await pool([`/mines/${id}/forecast`, `/mines/${id}/production?grain=week&days=364`, `/mines/${id}/equipment`, `/mines/${id}/blasting`,
      `/mines/${id}/geology`, `/mines/${id}/boreholes`, `/mines/${id}/reserves/scene`], 3, save);
    await save(`/mines/${id}/actions`);
    log(`  ${id} done`);
  }

  // drill-hole logs shown in the Reserves page selector (holes with an ore intercept)
  const holeIds = [];
  for (const id of mines) {
    const scene = JSON.parse(fs.readFileSync(path.join(OUT, snapshotFile(`/mines/${id}/reserves/scene`)), 'utf8'));
    holeIds.push(...scene.holes.filter((h) => h.assays.some((a) => a[2] >= 15)).map((h) => h.id));
  }
  await pool(holeIds.map((h) => `/boreholes/${h}`), 6, save);

  fs.writeFileSync(path.join(OUT, '_meta.json'), JSON.stringify({ built_at: new Date().toISOString(), as_of: meta.as_of, files, mines }));
  log(`wrote ${files} files (${(bytes / 1e6).toFixed(1)} MB) to dist/snapshot/ · ${holeIds.length} drill-hole logs`);
  stop();
  process.exit(0);
} catch (e) {
  console.error('[snapshot] FAILED:', e.message);
  stop();
  process.exit(1);
}

/* Precomputed API responses (hosted deployment, e.g. Render).
 *
 * A small hosted instance (0.1–0.5 CPU) would need many minutes to run the Monte-Carlo forecasts and the
 * action-plan optimiser for eight mines. `npm run build:render` therefore runs them once on the build machine
 * (scripts/export-snapshot.mjs --out data/precomputed) against the same database the server then ships with,
 * and with PRECOMPUTED=1 the server answers those GET requests from the saved results. Everything else stays
 * live: what-if simulation, retraining, CSV import, live weather, source health and the model registry.
 * A CSV import changes the operating record, so it switches precomputed answers off and the server computes
 * from then on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.mjs';

const DIR = path.join(ROOT, 'data', 'precomputed');
/** Always computed live: cheap, or must reflect actions taken on this server. */
const LIVE = /^\/(health|meta|weather\/live|sources|models)(\?|$)/;
const files = new Map();
let active = false;

/** File name for an API path. Keep in sync with snapshotFile() in src/lib/api.js. */
export const snapshotFile = (p) => `${p.replace(/^\//, '').replace(/[/?&=]/g, '_')}.json`;

export function loadPrecomputed() {
  if (process.env.PRECOMPUTED !== '1' || !fs.existsSync(DIR)) return 0;
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json') && !f.startsWith('_')) files.set(f, fs.readFileSync(path.join(DIR, f)));
  active = files.size > 0;
  return files.size;
}
export const precomputedActive = () => active;
export function invalidatePrecomputed() { active = false; files.clear(); }

/** Parsed precomputed response for an API path, or null. */
export function precomputedJson(p) {
  const b = active && !LIVE.test(p) ? files.get(snapshotFile(p)) : null;
  return b ? JSON.parse(b) : null;
}

/** Express middleware (mounted on /api): serve a GET from the precomputed set when there is one. */
export function precomputedMiddleware(req, res, next) {
  if (!active || req.method !== 'GET' || LIVE.test(req.url)) return next();
  const b = files.get(snapshotFile(req.url));
  if (!b) return next();
  res.set('X-Precomputed', '1').type('json').send(b);
}

/* Seeded pseudo-random numbers so every simulation, seed run and Monte-Carlo forecast is reproducible. */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Fast integer mixing of several 32-bit values into one seed (no string building). */
export function mixSeed(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9 ^ a;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) ^ c;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f) ^ d;
  h ^= h >>> 15; h = Math.imul(h, 0x165667b1); h ^= h >>> 13;
  return h >>> 0;
}

export class Rng {
  constructor(seed) { this.a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0; this._spare = null; }
  /** re-seed in place (no allocation) */
  reseed(seed) { this.a = seed >>> 0; this._spare = null; return this; }
  next() {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.uniform(a, b + 1)); }
  chance(p) { return this.next() < p; }
  normal(mu = 0, sd = 1) {
    if (this._spare != null) { const s = this._spare; this._spare = null; return mu + sd * s; }
    let u, v, s;
    do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const k = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * k;
    return mu + sd * u * k;
  }
  /** lognormal with the given arithmetic mean and log-space sigma */
  lognormal(mean, sigma) { return mean * Math.exp(this.normal(-(sigma * sigma) / 2, sigma)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
}

/** Smooth, spatially correlated random field built from random plane waves (zero mean, ~unit variance). */
export function smoothField(rng, { waves = 14, minWl = 120, maxWl = 700 } = {}) {
  const comps = Array.from({ length: waves }, () => {
    const wl = rng.uniform(minWl, maxWl), th = rng.uniform(0, Math.PI);
    return { kx: (Math.cos(th) * 2 * Math.PI) / wl, ky: (Math.sin(th) * 2 * Math.PI) / wl, ph: rng.uniform(0, 2 * Math.PI) };
  });
  const k = Math.sqrt(2 / waves);
  return (x, y) => comps.reduce((s, c) => s + Math.cos(c.kx * x + c.ky * y + c.ph), 0) * k;
}
